import type { AlignedWord } from './alignment'

/**
 * Correctness thresholds. Forced-decoding confidence is a *relative* likelihood, not a
 * calibrated probability: its absolute scale shifts with the model, the microphone and the
 * reciter, so no single absolute cutoff can carry the verdict. See buildWordVerdicts.
 */
// A word whose confidence falls below this fraction of the recitation's own median is an
// outlier — the rest of the passage establishes what "recited" looks like for this reciter
// and this microphone, and this word does not resemble it.
const CONFIDENCE_OUTLIER_FACTOR = 0.5
// A confidence this low means the model found the word essentially absent from the audio,
// whatever the rest of the passage looks like.
const CONFIDENCE_ABSOLUTE_FLOOR = 0.05
// Below this, the transcription does not plausibly correspond to the selected passage at
// all, and the results card says so rather than presenting a misleading percentage.
export const PASSAGE_MATCH_FLOOR = 0.35

export interface AyahRange {
  ayahNumber: number
  numberInSurah: number
  start: number
  end: number
}

export type WordStatus = 'unreached' | 'correct' | 'wrong'

export interface WordVerdict {
  refIndex: number
  status: WordStatus
  /** Forced-decoding confidence (0–1), or null when that pass wasn't available and we
   * fell back to plain text matching against the free transcription. */
  confidence: number | null
  /** What the free decode guessed in this word's place — shown as a hint, not trusted
   * for the correctness verdict itself. */
  hypGuess: string | null
  freeStatus: AlignedWord['status'] | null
}

/** Buckets a free-decode alignment back into per-ayah slices — used to tell how far the
 * reciter has actually gotten (an ayah with no matched hypothesis word yet hasn't been
 * "reached"). */
export function bucketByAyah(aligned: AlignedWord[], ayahRanges: AyahRange[]): AlignedWord[][] {
  const buckets: AlignedWord[][] = ayahRanges.map(() => [])
  if (ayahRanges.length === 0) return buckets
  let ayahIdx = 0
  for (const w of aligned) {
    if (w.refIndex !== null) {
      while (ayahIdx < ayahRanges.length - 1 && w.refIndex >= ayahRanges[ayahIdx].end) ayahIdx++
    }
    buckets[Math.min(ayahIdx, buckets.length - 1)].push(w)
  }
  return buckets
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Decides which reference words were actually recited, by weighing evidence *against* each
 * word rather than looking for a reason to accept it.
 *
 * Three independent signals can indicate a problem:
 *   A. the word's confidence is an outlier below this recitation's own median — the rest of
 *      the passage establishes what "recited" looks like for this voice and microphone, and
 *      this word does not resemble it;
 *   B. its confidence is below an absolute floor, i.e. the model found it essentially absent;
 *   C. the free transcription disagrees, having heard a different word there or nothing.
 *
 * A word is called wrong when acoustic doubt is corroborated by the text (A or B, together
 * with C), or when the acoustic evidence is damning on its own (A and B together).
 *
 * Both halves of that rule exist because of a specific failure. Requiring corroboration is
 * what stops a correctly recited passage scoring 0%: forced-decoding confidence alone was
 * uniformly pessimistic, and with no counterweight it condemned every word. But an earlier
 * attempt at the fix accepted a word whenever *any* signal favoured it, which collapsed the
 * other way — everything scored 100%, real mistakes included. Evidence of error has to be
 * weighed, not merely outvoted by evidence of success.
 */
export function buildWordVerdicts(
  aligned: AlignedWord[],
  wordConfidences: number[] | null,
  wordCount: number,
  ayahRanges: AyahRange[],
): WordVerdict[] {
  const alignedByAyah = bucketByAyah(aligned, ayahRanges)
  const freeByRef = new Map<number, AlignedWord>()
  for (const w of aligned) if (w.refIndex !== null) freeByRef.set(w.refIndex, w)

  const reachedAt = (i: number) => {
    const ayahIdx = ayahRanges.findIndex((r) => i >= r.start && i < r.end)
    const bucket = ayahIdx >= 0 ? alignedByAyah[ayahIdx] : []
    return bucket.some((w) => w.hypIndex !== null)
  }

  // Median confidence across everything actually attempted, so the relative test below
  // compares each word against this recitation's own baseline rather than an absolute one.
  const reachedConfidences: number[] = []
  if (wordConfidences) {
    for (let i = 0; i < wordCount; i++) {
      if (reachedAt(i)) reachedConfidences.push(wordConfidences[i] ?? 0)
    }
  }
  const outlierFloor = median(reachedConfidences) * CONFIDENCE_OUTLIER_FACTOR

  return Array.from({ length: wordCount }, (_, i): WordVerdict => {
    if (!reachedAt(i)) return { refIndex: i, status: 'unreached', confidence: null, hypGuess: null, freeStatus: null }

    const freeEntry = freeByRef.get(i)
    const freeStatus = freeEntry?.status ?? 'missing'
    const hypGuess = freeEntry?.hypWord ?? null
    const textDisagrees = freeStatus !== 'correct'

    if (!wordConfidences) {
      return { refIndex: i, status: textDisagrees ? 'wrong' : 'correct', confidence: null, hypGuess, freeStatus }
    }

    const confidence = wordConfidences[i] ?? 0
    const isOutlier = confidence < outlierFloor
    const belowFloor = confidence < CONFIDENCE_ABSOLUTE_FLOOR
    const acousticDoubt = isOutlier || belowFloor
    const wrong = (acousticDoubt && textDisagrees) || (isOutlier && belowFloor)

    return { refIndex: i, status: wrong ? 'wrong' : 'correct', confidence, hypGuess, freeStatus }
  })
}
