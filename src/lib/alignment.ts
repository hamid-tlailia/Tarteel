export type WordStatus = 'correct' | 'substituted' | 'missing' | 'extra'

/**
 * Bounded edit distance check: true when `a`/`b` differ by few enough character edits to be
 * the same word mis-heard by the ASR (a swapped letter, a dropped/duplicated one), rather
 * than a genuinely different word. Requiring exact equality here was too strict for the
 * free-decode fallback path (used when the forced-decoding confidence pass isn't available)
 * — a single near-miss letter would count a correctly-recited word as "substituted".
 * Skipped for very short words (1 char), where any edit is too large a fraction of the word
 * to be a safe near-miss call.
 */
export function editClose(a: string, b: string): boolean {
  if (a === b) return true
  const n = a.length
  const m = b.length
  if (Math.min(n, m) < 2 || Math.abs(n - m) > 2) return false
  const maxD = Math.max(1, Math.floor(Math.max(n, m) / 3))
  const dp: number[] = Array.from({ length: m + 1 }, (_, j) => j)
  for (let i = 1; i <= n; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = tmp
    }
  }
  return dp[m] <= maxD
}

export interface AlignedWord {
  status: WordStatus
  refIndex: number | null
  hypIndex: number | null
  refWord: string | null
  hypWord: string | null
}

/**
 * Global alignment (Needleman-Wunsch) between the reference recitation and the
 * ASR hypothesis, on normalized words. Substitution cost 2, gap cost 1, so a
 * single-letter mismatch prefers "substituted" over "missing"+"extra".
 */
/**
 * Word costs for the alignment.
 *
 * A match is *rewarded* rather than merely free. With matches costing nothing, two very
 * different readings of the same recitation could cost the same — and did: reciting only the
 * basmala against al-Fātiḥah 1–3, "the basmala, then stopped" and "بسم from ayah 1, لله from
 * ayah 2, الرحمن الرحيم from ayah 3" both matched four words and skipped six. The backtrace,
 * walking from the end, took the latest matches — so the display revealed ayah 3 and marked
 * ayah 2 missed, when the reciter had not reached either. A reward makes the reading that
 * keeps matched words together cheaper than one that scatters them.
 */
const MATCH_COST = -2
const MISMATCH_COST = 2
const GAP_COST = 1

export function alignWords(refWords: string[], hypWords: string[]): AlignedWord[] {
  const n = refWords.length
  const m = hypWords.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 0; i <= n; i++) dp[i][0] = i * GAP_COST
  for (let j = 0; j <= m; j++) dp[0][j] = j * GAP_COST

  const pairCost = (i: number, j: number) => (editClose(refWords[i - 1], hypWords[j - 1]) ? MATCH_COST : MISMATCH_COST)

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = dp[i - 1][j - 1] + pairCost(i, j)
      const del = dp[i - 1][j] + GAP_COST
      const ins = dp[i][j - 1] + GAP_COST
      dp[i][j] = Math.min(sub, del, ins)
    }
  }

  // The reciter recites a *prefix* of the passage and may stop anywhere, so the reference
  // words after the last one they reached are not skipped — they are simply not yet reached,
  // and must cost nothing. The alignment therefore ends at whichever reference position
  // explains the whole recitation most cheaply, the earliest on a tie; everything after it is
  // reported as missing with no hypothesis word, which is what marks those ayahs unreached
  // rather than failed.
  let endRow = 0
  for (let i = 1; i <= n; i++) if (dp[i][m] < dp[endRow][m]) endRow = i

  const result: AlignedWord[] = []
  for (let k = n; k > endRow; k--) {
    result.push({ status: 'missing', refIndex: k - 1, hypIndex: null, refWord: refWords[k - 1], hypWord: null })
  }

  let i = endRow
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const match = editClose(refWords[i - 1], hypWords[j - 1])
      if (dp[i][j] === dp[i - 1][j - 1] + (match ? MATCH_COST : MISMATCH_COST)) {
        result.push({
          status: match ? 'correct' : 'substituted',
          refIndex: i - 1,
          hypIndex: j - 1,
          refWord: refWords[i - 1],
          hypWord: hypWords[j - 1],
        })
        i--
        j--
        continue
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + GAP_COST) {
      result.push({ status: 'missing', refIndex: i - 1, hypIndex: null, refWord: refWords[i - 1], hypWord: null })
      i--
      continue
    }
    result.push({ status: 'extra', refIndex: null, hypIndex: j - 1, refWord: null, hypWord: hypWords[j - 1] })
    j--
  }

  return result.reverse()
}

export interface RecitationScore {
  correct: number
  substituted: number
  missing: number
  extra: number
  total: number
  accuracy: number
}

export function scoreAlignment(aligned: AlignedWord[]): RecitationScore {
  const correct = aligned.filter((w) => w.status === 'correct').length
  const substituted = aligned.filter((w) => w.status === 'substituted').length
  const missing = aligned.filter((w) => w.status === 'missing').length
  const extra = aligned.filter((w) => w.status === 'extra').length
  const total = correct + substituted + missing
  const accuracy = total === 0 ? 0 : Math.round((correct / total) * 100)
  return { correct, substituted, missing, extra, total, accuracy }
}
