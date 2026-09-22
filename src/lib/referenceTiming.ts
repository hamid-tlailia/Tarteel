import type { WordWithRules } from './tajweed'
import { expectedDurationBreakdown } from './wordTiming'
import type { PaceId } from './recitationPace'

/**
 * Judging a learner against an accredited reciter instead of against constants.
 *
 * Everything else in this app measures a hold against numbers reasoned from the books: a
 * ḥaraka is so many milliseconds, a muttaṣil is four of them. Those numbers are defensible
 * but they are still mine. A published recording by a muqriʾ is not — it is what the ruling
 * sounds like when performed correctly, and the app already has one for every ayah.
 *
 * So when a reference recitation has been aligned (same forced-alignment pass the learner's
 * own recording goes through), this replaces the theoretical obligation with the one the
 * reciter actually delivered. The learner is still not required to match the reciter's
 * absolute speed — that would only be judging pace again — but the *proportion* the reciter
 * gives to a madd, relative to the plain syllables around it, is the thing being taught.
 *
 * Nothing here is required: with no reference the checks fall back to the theoretical
 * durations exactly as before.
 */

export interface ReferenceTiming {
  reciterId: string
  /** Per reference word, the reciter's own [start, end] in seconds. Null where alignment
   * gave nothing for that word. Same order and length as the passage's words. */
  wordTimings: ([number, number] | null)[]
}

/**
 * What the reciter's recording implies each word should take, expressed in the learner's own
 * tempo.
 *
 * The scale is taken from words carrying *no* held rule. Using every word would let the very
 * madds under examination set the conversion between the two recitations, so a learner who
 * uniformly clipped every madd would be rescaled until their clipping vanished — the same
 * trap as letting a word set its own yardstick.
 */
export interface ReferenceExpectation {
  /** Expected total duration for this word, in the learner's tempo, in ms. */
  totalMs: number
  /** What it would be with the madd not elongated at all. */
  withoutMaddMs: number
  /** The same for a word judged on its ghunnah. */
  withoutGhunnahMs: number
}

const MIN_ANCHOR_WORDS = 2

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function durationsOf(timings: ([number, number] | null)[]): (number | null)[] {
  return timings.map((t) => {
    if (!t) return null
    const ms = (t[1] - t[0]) * 1000
    return ms > 0 ? ms : null
  })
}

/** Whether a word's duration is dominated by a hold, and so cannot anchor the comparison. */
function isAnchor(word: WordWithRules, paceId: PaceId | undefined): boolean {
  const b = expectedDurationBreakdown(word, paceId)
  return b.withoutMadd >= b.total && b.withoutGhunnah >= b.total
}

/**
 * Converts the reciter's timings into expectations for this learner, or null when the two
 * recitations cannot be related — too few words in common, or no plain word to anchor on.
 */
export function referenceExpectations(
  referenceWords: WordWithRules[],
  learnerTimings: ([number, number] | null)[],
  reference: ReferenceTiming,
  paceId?: PaceId,
): (ReferenceExpectation | null)[] | null {
  const learner = durationsOf(learnerTimings)
  const reciter = durationsOf(reference.wordTimings)
  if (reciter.length !== referenceWords.length) return null

  // How much slower or faster this learner is than the reciter, measured only on the words
  // neither of them is being judged on.
  const ratios: number[] = []
  referenceWords.forEach((word, i) => {
    if (!isAnchor(word, paceId)) return
    const l = learner[i]
    const r = reciter[i]
    if (l === null || r === null) return
    ratios.push(l / r)
  })
  if (ratios.length < MIN_ANCHOR_WORDS) return null
  const tempo = Math.min(3, Math.max(0.33, median(ratios)))

  return referenceWords.map((word, i) => {
    const r = reciter[i]
    if (r === null) return null
    const theory = expectedDurationBreakdown(word, paceId)
    if (theory.total <= 0) return null

    // The reciter's word, brought into the learner's tempo. Its split into "held" and
    // "unheld" parts still comes from the theory, since alignment gives word boundaries and
    // not letter ones — but the *total* is now a real performance rather than a constant,
    // and the split is applied as the proportion that performance implies.
    const totalMs = r * tempo
    const scale = totalMs / theory.total
    return {
      totalMs,
      withoutMaddMs: theory.withoutMadd * scale,
      withoutGhunnahMs: theory.withoutGhunnah * scale,
    }
  })
}

/**
 * How closely the learner's recitation follows the reciter's shape, 0–1.
 *
 * Reported rather than scored: it says "your reading moves like this reciter's" and is at
 * its most useful when the learner has chosen one to imitate. Computed from how consistent
 * the per-word ratio is, so a learner reading uniformly slower than the reciter still scores
 * high — following is not copying the speed.
 */
export function followScore(
  referenceWords: WordWithRules[],
  learnerTimings: ([number, number] | null)[],
  reference: ReferenceTiming,
): number | null {
  const learner = durationsOf(learnerTimings)
  const reciter = durationsOf(reference.wordTimings)
  if (reciter.length !== referenceWords.length) return null

  const ratios: number[] = []
  for (let i = 0; i < referenceWords.length; i++) {
    const l = learner[i]
    const r = reciter[i]
    if (l !== null && r !== null) ratios.push(l / r)
  }
  if (ratios.length < MIN_ANCHOR_WORDS) return null

  const centre = median(ratios)
  if (centre <= 0) return null
  // Mean absolute deviation on a log scale, so being twice as long and half as long are
  // equally far from the reciter.
  const spread = ratios.reduce((sum, r) => sum + Math.abs(Math.log(r / centre)), 0) / ratios.length
  // log(1.5) ≈ 0.405 — a word half again as long as it should be relative to the rest is the
  // point at which the shape no longer resembles the reciter's at all.
  return Math.max(0, Math.min(1, 1 - spread / Math.log(1.5)))
}
