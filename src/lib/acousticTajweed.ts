import type { WordWithRules } from './tajweed'
import type { TajweedRuleId } from '../types/quran'
import type { AlignedWord } from './alignment'
import type { TimedChunk } from '../asr/whisper.worker'
import { expectedDurationBreakdown } from './wordTiming'

/**
 * Heuristic acoustic check for madd (elongation) rules — the step beyond plain text
 * comparison. Whisper's text output cannot tell a rushed madd from a full one, since both
 * transcribe to the same word, so this compares each recited word's *duration* against the
 * duration that word should take: its syllable count plus the ḥarakāt its own rules call
 * for (see wordTiming.ts), scaled by the pace this particular reciter is reading at.
 *
 * Still a heuristic, not ground truth — it measures the whole word, not the madd letter
 * within it. Only words the caller has already confirmed were actually recited are checked
 * (via `correctRefIndices`, from forced-decoding confidence — see whisper.worker.ts).
 */

const MADD_RULES = new Set<TajweedRuleId>([
  'madda_normal',
  'madda_permissible',
  'madda_obligatory',
  'madda_necessary',
])

/** How far under its expected duration a word may fall before the madd is called short.
 * Generous on purpose: recitation pace varies within a single passage, and telling a
 * reciter they dropped a madd they actually performed is the more damaging error. */
const MADD_TOLERANCE = 0.3

/** How close to the no-elongation duration counts as "the madd is not there at all".
 * A band rather than an exact boundary, because word timings come from the ASR at roughly
 * 20ms resolution — far coarser than the knife edge an exact comparison would draw. */
const MADD_DROPPED_MARGIN = 1.15

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export interface AcousticAlert {
  refIndex: number
  word: string
  rule: TajweedRuleId
  durationMs: number
  expectedMinMs: number
  /** 'severe': the word took no longer than it would have with no elongation at all, so
   * the madd looks absent. 'mild': elongated, but short of what the rule asks for. */
  severity: 'mild' | 'severe'
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Primary path: uses precise per-reference-word timing from forced alignment (cross-
 * attention + DTW against the *known* text — see scoreAndAlignReferenceWords in
 * whisper.worker.ts). The measured span is the madd word's own forced time range, not
 * whatever word a free decode happened to guess in its place.
 */
export function detectMaddDurationAlertsForced(
  referenceWords: WordWithRules[],
  wordTimings: ([number, number] | null)[],
  correctRefIndices: Set<number>,
): AcousticAlert[] {
  // Each word is judged against *its own* expected duration (syllable count + the rules it
  // carries), not against a flat median of every word in the passage.
  //
  // The flat median was badly wrong in two compounding ways. It was contaminated by the
  // madd words themselves — in a passage like «قُلْ يَـٰٓأَيُّهَا ٱلْكَـٰفِرُونَ», where two of
  // three words carry madd, the median *is* an elongated word, so a correctly elongated
  // madd could never clear the required multiple of it and was reported as dropped. And it
  // ignored syllable count entirely, so a long word was credited with elongation it never
  // had while a short one was condemned for lacking elongation it did perform.
  const ratios: number[] = []
  referenceWords.forEach((refWord, i) => {
    const timing = wordTimings[i]
    if (!timing) return
    const measuredMs = (timing[1] - timing[0]) * 1000
    if (measuredMs <= 0) return
    const expected = expectedDurationBreakdown(refWord)
    if (expected.total > 0) ratios.push(measuredMs / expected.total)
  })
  if (ratios.length < 3) return []

  // The reciter's own pace, as a multiple of the reference tempo. Taking the median keeps
  // one rushed or drawn-out word from dragging the whole scale with it.
  const tempoScale = clamp(median(ratios), 0.4, 2.5)

  const alerts: AcousticAlert[] = []
  referenceWords.forEach((refWord, i) => {
    if (!correctRefIndices.has(i)) return
    const timing = wordTimings[i]
    if (!timing) return
    const maddRule = refWord.rules.find((r) => MADD_RULES.has(r))
    if (!maddRule) return

    const measuredMs = (timing[1] - timing[0]) * 1000
    if (measuredMs <= 0) return

    const expected = expectedDurationBreakdown(refWord)
    const expectedMs = expected.total * tempoScale
    // "Dropped entirely" now means something checkable: the word took no longer than it
    // would have without elongating its madd letter at all, at this reciter's own pace.
    const noMaddMs = expected.withoutMadd * tempoScale

    if (measuredMs >= expectedMs * (1 - MADD_TOLERANCE)) return

    alerts.push({
      refIndex: i,
      word: refWord.word,
      rule: maddRule,
      durationMs: measuredMs,
      expectedMinMs: expectedMs * (1 - MADD_TOLERANCE),
      severity: measuredMs <= noMaddMs * MADD_DROPPED_MARGIN ? 'severe' : 'mild',
    })
  })
  return alerts
}

/**
 * Fallback path for when forced-alignment timing isn't available this time: approximates
 * each word's duration from the free decode's own (unforced) word timestamps via the
 * free-decode alignment. Less precise — the "word" boundaries come from whatever the free
 * decode guessed, which may not exactly match the reference word's real span.
 */
export function detectMaddDurationAlertsFromFreeDecode(
  aligned: AlignedWord[],
  referenceWords: WordWithRules[],
  chunks: TimedChunk[],
  correctRefIndices: Set<number>,
): AcousticAlert[] {
  if (chunks.length < 3) return []

  /** Measured duration in ms for the reference word an alignment entry points at. */
  const measuredMsOf = (w: AlignedWord): number | null => {
    if (w.hypIndex === null) return null
    const chunk = chunks[w.hypIndex]
    const start = chunk?.timestamp?.[0]
    const end = chunk?.timestamp?.[1]
    if (typeof start !== 'number' || typeof end !== 'number') return null
    const ms = (end - start) * 1000
    return ms > 0 ? ms : null
  }

  // Same syllable-and-rule-aware comparison as the forced path above — see the note there
  // for why a flat median of every word's duration was the wrong baseline.
  const ratios: number[] = []
  for (const w of aligned) {
    if (w.refIndex === null) continue
    const refWord = referenceWords[w.refIndex]
    if (!refWord) continue
    const measuredMs = measuredMsOf(w)
    if (measuredMs === null) continue
    const expected = expectedDurationBreakdown(refWord)
    if (expected.total > 0) ratios.push(measuredMs / expected.total)
  }
  if (ratios.length < 3) return []
  const tempoScale = clamp(median(ratios), 0.4, 2.5)

  const alerts: AcousticAlert[] = []
  for (const w of aligned) {
    if (w.refIndex === null || w.hypIndex === null) continue
    if (!correctRefIndices.has(w.refIndex)) continue
    const refWord = referenceWords[w.refIndex]
    const maddRule = refWord?.rules.find((r) => MADD_RULES.has(r))
    if (!maddRule) continue

    const measuredMs = measuredMsOf(w)
    if (measuredMs === null) continue

    const expected = expectedDurationBreakdown(refWord)
    const expectedMs = expected.total * tempoScale
    const noMaddMs = expected.withoutMadd * tempoScale
    if (measuredMs >= expectedMs * (1 - MADD_TOLERANCE)) continue

    alerts.push({
      refIndex: w.refIndex,
      word: refWord.word,
      rule: maddRule,
      durationMs: measuredMs,
      expectedMinMs: expectedMs * (1 - MADD_TOLERANCE),
      severity: measuredMs <= noMaddMs * MADD_DROPPED_MARGIN ? 'severe' : 'mild',
    })
  }
  return alerts
}
