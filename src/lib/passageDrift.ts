import type { Ayah } from '../types/quran'
import { normalizeArabic } from './arabicText'
import { segmentsToWords } from './tajweed'
import { scoreTranscriptMatch } from './transcriptMatch'

/**
 * When a reciter's memory slips from the ayah in front of them into a similar one elsewhere.
 *
 * This is the commonest failure in ḥifẓ and the one the app was worst at explaining. Telling
 * someone their recitation "did not match the selected passage" is true and useless; telling
 * them they recited 2:7 instead of 2:6 names what happened and what to revise. The similar
 * passages — al-mutashābihāt — are exactly the places this occurs, and they cluster within a
 * surah, which is convenient: the whole surah is already downloaded, so this costs a few
 * string comparisons and no network at all.
 *
 * Deliberately limited to the surah in hand. Finding the drift across the whole Qur'an would
 * mean shipping or fetching its full text, and the payoff outside the current surah is much
 * smaller — a reciter working on al-Baqara who slips does so into another part of al-Baqara
 * far more often than into Yā-Sīn.
 */

export interface PassageDrift {
  /** The ayah the reciter appears to have recited instead. */
  ayah: Ayah
  /** How well the transcript matched it, 0–1. */
  score: number
  /** How well it matched the passage they were asked to recite. */
  selectedScore: number
}

/**
 * How much better the other ayah must match before this is claimed.
 *
 * A neighbouring ayah in the same surah shares vocabulary and cadence, so a correct
 * recitation of the selected passage will still score respectably against the ayah after it.
 * Only a clear margin means a drift rather than a family resemblance, and the cost of being
 * wrong here is high: telling a reciter who read correctly that they recited something else
 * is worse than saying nothing.
 */
const DRIFT_MARGIN = 0.25
/** Below this the transcript resembles nothing in the surah, so there is no drift to report
 * — it is the "that was not this recitation at all" case, which the caller already handles. */
const DRIFT_FLOOR = 0.45

/**
 * How well a transcript matches one candidate ayah, with length taken into account.
 *
 * scoreTranscriptMatch asks "how much of the reference did the reciter cover", which is the
 * right question for the passage they were asked to recite and the wrong one here. Sūrat
 * al-Baqara opens with «الٓمٓ» — one word — so a fifty-word recitation of Āyat al-Kursī covers
 * all of it and scores a perfect 1, and the drift was duly reported as 2:1. Requiring the two
 * to be of comparable length as well as of comparable content settles it: a candidate is only
 * what was recited if it accounts for the recitation, not merely if the recitation contains
 * it.
 */
function candidateScore(hypothesisWords: string[], candidateWords: string[]): number {
  const { score } = scoreTranscriptMatch(hypothesisWords, candidateWords)
  const lengthAgreement =
    Math.min(hypothesisWords.length, candidateWords.length) /
    Math.max(hypothesisWords.length, candidateWords.length)
  return score * lengthAgreement
}

export function findPassageDrift(
  hypothesisWords: string[],
  surahAyahs: Ayah[],
  selectedAyahNumbers: Set<number>,
  selectedScore: number,
): PassageDrift | null {
  if (hypothesisWords.length === 0) return null

  let best: PassageDrift | null = null
  for (const ayah of surahAyahs) {
    if (selectedAyahNumbers.has(ayah.numberInSurah)) continue
    const words = segmentsToWords(ayah.segments).map((w) => normalizeArabic(w.word))
    if (words.length === 0) continue
    const score = candidateScore(hypothesisWords, words)
    if (!best || score > best.score) best = { ayah, score, selectedScore }
  }

  if (!best) return null
  if (best.score < DRIFT_FLOOR) return null
  if (best.score < selectedScore + DRIFT_MARGIN) return null
  return best
}
