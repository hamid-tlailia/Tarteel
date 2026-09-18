export type WordStatus = 'correct' | 'substituted' | 'missing' | 'extra'

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
export function alignWords(refWords: string[], hypWords: string[]): AlignedWord[] {
  const n = refWords.length
  const m = hypWords.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 0; i <= n; i++) dp[i][0] = i
  for (let j = 0; j <= m; j++) dp[0][j] = j

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const match = refWords[i - 1] === hypWords[j - 1]
      const sub = dp[i - 1][j - 1] + (match ? 0 : 2)
      const del = dp[i - 1][j] + 1
      const ins = dp[i][j - 1] + 1
      dp[i][j] = Math.min(sub, del, ins)
    }
  }

  const result: AlignedWord[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const match = refWords[i - 1] === hypWords[j - 1]
      if (dp[i][j] === dp[i - 1][j - 1] + (match ? 0 : 2)) {
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
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
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
