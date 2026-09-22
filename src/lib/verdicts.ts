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

/**
 * If the median confidence across a whole recitation is under this, the forced pass is not
 * measuring anything — a correctly recited word scores no better than a skipped one, and
 * whatever separates them is noise in the fourth decimal place. That is a broken signal, not
 * a strict one, and a verdict drawn from it is a coin toss dressed up as a judgement.
 *
 * This is not hypothetical: a perfect recitation of Sūrat al-Qadr came back with every word
 * between 0.0% and 0.2%, and two words were condemned purely by where that noise happened to
 * fall. The signal is discarded in that case and correctness falls back to the transcript
 * alone, which the results card states plainly rather than quietly pretending to more
 * precision than it has.
 */
export const CONFIDENCE_DEGENERATE_MEDIAN = 0.01

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

/** Whether the forced-decoding pass produced a distribution worth judging words by — see
 * CONFIDENCE_DEGENERATE_MEDIAN. The results card uses this to say which mode it is in. */
export function isConfidenceUsable(wordConfidences: number[] | null): boolean {
  if (!wordConfidences || wordConfidences.length === 0) return false
  return median(wordConfidences) >= CONFIDENCE_DEGENERATE_MEDIAN
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
/** The last ayah that received any recited word, or -1 if none did. */
export function lastReachedAyahIndex(alignedByAyah: AlignedWord[][]): number {
  for (let k = alignedByAyah.length - 1; k >= 0; k--) {
    if (alignedByAyah[k].some((w) => w.hypIndex !== null)) return k
  }
  return -1
}

export function buildWordVerdicts(
  aligned: AlignedWord[],
  wordConfidences: number[] | null,
  wordCount: number,
  ayahRanges: AyahRange[],
): WordVerdict[] {
  const alignedByAyah = bucketByAyah(aligned, ayahRanges)
  const freeByRef = new Map<number, AlignedWord>()
  for (const w of aligned) if (w.refIndex !== null) freeByRef.set(w.refIndex, w)

  // An ayah is reached if it — or any ayah after it — received recited words. The second
  // half matters: an ayah passed over while later ones were recited was *skipped*, and must
  // be reported as such. Judging each ayah only by its own words called a skipped middle ayah
  // "not reached yet", which hides exactly the fault a reciter needs to hear about, while the
  // tail the reciter simply had not got to stays unreached, as it should.
  const lastReachedAyah = lastReachedAyahIndex(alignedByAyah)
  const reachedAt = (i: number) => {
    const ayahIdx = ayahRanges.findIndex((r) => i >= r.start && i < r.end)
    return ayahIdx >= 0 && ayahIdx <= lastReachedAyah
  }

  // Median confidence across everything actually attempted, so the relative test below
  // compares each word against this recitation's own baseline rather than an absolute one.
  const reachedConfidences: number[] = []
  if (wordConfidences) {
    for (let i = 0; i < wordCount; i++) {
      if (reachedAt(i)) reachedConfidences.push(wordConfidences[i] ?? 0)
    }
  }
  const medianConfidence = median(reachedConfidences)
  // A confidence distribution this flat and this low is measuring nothing — discard it
  // rather than let noise decide verdicts. See CONFIDENCE_DEGENERATE_MEDIAN.
  const usableConfidences =
    wordConfidences && medianConfidence >= CONFIDENCE_DEGENERATE_MEDIAN ? wordConfidences : null
  const outlierFloor = medianConfidence * CONFIDENCE_OUTLIER_FACTOR

  return Array.from({ length: wordCount }, (_, i): WordVerdict => {
    if (!reachedAt(i)) return { refIndex: i, status: 'unreached', confidence: null, hypGuess: null, freeStatus: null }

    const freeEntry = freeByRef.get(i)
    const freeStatus = freeEntry?.status ?? 'missing'
    const hypGuess = freeEntry?.hypWord ?? null
    const textDisagrees = freeStatus !== 'correct'

    if (!usableConfidences) {
      const confidence = wordConfidences ? (wordConfidences[i] ?? 0) : null
      return { refIndex: i, status: textDisagrees ? 'wrong' : 'correct', confidence, hypGuess, freeStatus }
    }

    const confidence = usableConfidences[i] ?? 0
    const isOutlier = confidence < outlierFloor
    const belowFloor = confidence < CONFIDENCE_ABSOLUTE_FLOOR
    const acousticDoubt = isOutlier || belowFloor

    /*
     * Both signals must agree before a word is called wrong.
     *
     * There used to be a second clause — `|| (isOutlier && belowFloor)` — letting collapsed
     * confidence convict on its own. Since a word whose confidence collapses *and* whose
     * text disagrees is already caught by the first clause, that second one could only ever
     * fire where the free decode positively said the word was right: a single pessimistic
     * signal overruling a second signal that disagreed with it, which is exactly what this
     * file's design is written to prevent.
     *
     * It fell hardest on the first word of a recitation, where forced-decoding confidence is
     * lowest by construction: the decoder has nothing but the prompt tokens for context, and
     * the recorder often clips the onset of a reciter who starts immediately. «بِسْمِ» came
     * back marked wrong in a recitation of al-Fātiḥah whose other three words were fine.
     */
    const wrong = acousticDoubt && textDisagrees

    return { refIndex: i, status: wrong ? 'wrong' : 'correct', confidence, hypGuess, freeStatus }
  })
}
