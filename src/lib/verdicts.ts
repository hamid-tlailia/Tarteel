import type { AlignedWord } from './alignment'

/**
 * Correctness thresholds. Forced-decoding confidence is a *relative* likelihood, not a
 * calibrated probability, and its absolute scale shifts with the model, the microphone and
 * the reciter — so correctness never rests on one absolute cutoff alone. See
 * buildWordVerdicts for how these combine.
 */
// A word whose tokens average this probability or better is accepted outright.
const CONFIDENCE_THRESHOLD = 0.1
// …and a word is also accepted if it is within this fraction of the median confidence of
// everything else recited in the same pass. This self-calibrates: if the audio or model is
// weak, every confidence drops together and the relative comparison still separates the
// word that was actually skipped from the ones that were merely recorded quietly.
const CONFIDENCE_RELATIVE_FACTOR = 0.4
// …but only when the transcription as a whole plausibly *is* this passage. Below this, the
// reciter is likely reading something else entirely, and the relative leniency (which would
// otherwise pass every word, since all confidences would be uniformly low) is withheld.
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
 * Decides which reference words were actually recited, from two *independent* signals:
 *
 *  1. forced-decoding confidence — precise, and immune to the ASR's bias toward guessing a
 *     more statistically common phrase (the "الحاقة → الحم" failure), but its absolute
 *     scale is uncalibrated and shifts with model, microphone and reciter;
 *  2. the free transcription's fuzzy text match — coarse and occasionally fooled by that
 *     same bias, but never uniformly pessimistic.
 *
 * A word is accepted when *either* signal supports it, and only called wrong when both
 * agree. That asymmetry is the whole point: relying on forced-decoding confidence alone is
 * what made a correctly recited ayah score 0%, because one pessimistic signal had no
 * counterweight. A false "correct" costs far less here than a false "wrong", which tells a
 * reciter they erred when they did not.
 */
export function buildWordVerdicts(
  aligned: AlignedWord[],
  wordConfidences: number[] | null,
  wordCount: number,
  ayahRanges: AyahRange[],
  passageMatch: number,
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
  const relativeFloor = median(reachedConfidences) * CONFIDENCE_RELATIVE_FACTOR

  return Array.from({ length: wordCount }, (_, i): WordVerdict => {
    if (!reachedAt(i)) return { refIndex: i, status: 'unreached', confidence: null, hypGuess: null, freeStatus: null }

    const freeEntry = freeByRef.get(i)
    const freeStatus = freeEntry?.status ?? 'missing'
    const hypGuess = freeEntry?.hypWord ?? null
    const freeSaysCorrect = freeStatus === 'correct'

    if (!wordConfidences) {
      return { refIndex: i, status: freeSaysCorrect ? 'correct' : 'wrong', confidence: null, hypGuess, freeStatus }
    }

    const confidence = wordConfidences[i] ?? 0
    const passesAbsolute = confidence >= CONFIDENCE_THRESHOLD
    const passesRelative = passageMatch >= PASSAGE_MATCH_FLOOR && confidence >= relativeFloor
    const status: WordStatus = freeSaysCorrect || passesAbsolute || passesRelative ? 'correct' : 'wrong'
    return { refIndex: i, status, confidence, hypGuess, freeStatus }
  })
}
