/**
 * How closely the free transcription resembles the reference passage, as a whole.
 *
 * Deliberately *lenient*, and deliberately the maximum of several different similarity
 * measures rather than one strict one. The ASR often returns the right recitation with the
 * wrong word boundaries, a missing space, or a near-miss spelling; judging that on exact
 * word equality alone reports 0% for a reading that was actually fine. Taking the best of
 * word-level, character-level and trigram similarity means a genuinely correct recitation
 * always scores high through at least one of them, while an unrelated utterance scores low
 * through all three.
 *
 * Used as a corroborating signal alongside forced-decoding confidence (see
 * buildWordVerdicts in PracticePage.tsx): a word is only ever called wrong when *both*
 * signals agree it is, which is what prevents a single pessimistic signal from wiping out
 * the whole score.
 */

import { editClose } from './alignment'

/** Length of the longest common subsequence of two strings. */
function lcsLength(a: string, b: string): number {
  const n = a.length
  const m = b.length
  if (!n || !m) return 0
  let prev = new Int32Array(m + 1)
  let cur = new Int32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const tmp = prev
    prev = cur
    cur = tmp
    cur.fill(0)
  }
  return prev[m]
}

/** Share of the reference's character trigrams that also appear in the hypothesis — a
 * cheap stand-in for LCS on passages long enough that the quadratic version would stall. */
function trigramOverlap(hyp: string, ref: string): number {
  const grams = (s: string) => {
    const set = new Set<string>()
    const padded = ` ${s} `
    for (let i = 0; i + 2 < padded.length; i++) set.add(padded.slice(i, i + 3))
    return set
  }
  const hypGrams = grams(hyp)
  const refGrams = grams(ref)
  if (!hypGrams.size || !refGrams.size) return 0
  let shared = 0
  for (const g of refGrams) if (hypGrams.has(g)) shared++
  return shared / refGrams.size
}

/** Above this many character-pairs, LCS is replaced by the trigram approximation. */
const LCS_CHAR_BUDGET = 250_000

export interface TranscriptMatch {
  /** 0–1: how much of the reference the transcription covers, by the most favourable measure. */
  score: number
  /** True when the transcription contained no usable Arabic at all (silence, noise, or a
   * failed decode) — the caller should not draw word-level conclusions from it. */
  empty: boolean
}

/**
 * @param hypWords  normalized words from the ASR transcription
 * @param refWords  normalized words of the reference passage
 */
export function scoreTranscriptMatch(hypWords: string[], refWords: string[]): TranscriptMatch {
  if (refWords.length === 0) return { score: 0, empty: true }
  if (hypWords.length === 0) return { score: 0, empty: true }

  const hypChars = hypWords.join('')
  const refChars = refWords.join('')
  if (!hypChars || !refChars) return { score: 0, empty: true }

  // Word-level, with near-miss tolerance: the longest common subsequence over the word
  // arrays (a word counts as shared when it is within a letter or two of the reference's),
  // as a share of the reference. This is the primary measure.
  const wordScore = fuzzyWordLcs(hypWords, refWords) / refWords.length

  // Character-level is deliberately NOT blended in as a peer. Arabic words share so many
  // letters that the longest common subsequence between two entirely unrelated passages
  // still runs to ~40% of the reference — enough, when taken as a peer measure, to pass a
  // recitation of a completely different sūrah as a match. It earns its place only in the
  // one case the word-level measure genuinely cannot handle: a transcription that came back
  // with no usable word boundaries at all, where every "word" comparison is meaningless.
  const unsegmented = hypWords.length <= Math.max(1, Math.floor(refWords.length / 3))
  if (!unsegmented) return { score: Math.min(1, Math.max(0, wordScore)), empty: false }

  const charScore =
    hypChars.length * refChars.length > LCS_CHAR_BUDGET
      ? trigramOverlap(hypChars, refChars)
      : lcsLength(hypChars, refChars) / refChars.length
  return { score: Math.min(1, Math.max(0, Math.max(wordScore, charScore))), empty: false }
}

/** Longest common subsequence over two word arrays, counting near-miss spellings as equal. */
function fuzzyWordLcs(hypWords: string[], refWords: string[]): number {
  const n = hypWords.length
  const m = refWords.length
  let prev = new Int32Array(m + 1)
  let cur = new Int32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = editClose(hypWords[i - 1], refWords[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    const tmp = prev
    prev = cur
    cur = tmp
    cur.fill(0)
  }
  return prev[m]
}
