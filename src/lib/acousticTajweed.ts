import type { WordWithRules } from './tajweed'
import type { TajweedRuleId } from '../types/quran'
import type { AlignedWord } from './alignment'
import type { TimedChunk } from '../asr/whisper.worker'

/**
 * Heuristic acoustic check for madd (elongation) rules — the first step beyond plain
 * text comparison. Whisper's ASR text output can't tell a rushed madd from a full one
 * (both transcribe to the same word), so this looks at the *duration* of each recited
 * word (from Whisper's word-level timestamps) relative to the reciter's own median word
 * duration, and flags madd-tagged words that were recited noticeably shorter than the
 * elongation their rule requires.
 *
 * This is a deliberately simple v1: real madd length depends on syllable count and local
 * tempo too, and Whisper's word timestamps have some jitter, especially on a general
 * (non-Quran-specialized) model — so treat this as an experimental signal, not ground truth.
 *
 * Only checks words the caller has already confirmed were actually recited (via
 * `correctRefIndices` — typically from forced-decoding confidence, see whisper.worker.ts);
 * timing for those words still comes from the free-decode alignment's word timestamps.
 */

const MADD_MIN_RELATIVE_DURATION: Partial<Record<TajweedRuleId, number>> = {
  madda_normal: 1.15,
  madda_permissible: 1.35,
  madda_necessary: 1.5,
  madda_obligatory: 1.8,
}

export interface AcousticAlert {
  refIndex: number
  word: string
  rule: TajweedRuleId
  durationMs: number
  expectedMinMs: number
  /** 'severe': recited no longer than an average plain word — the madd looks dropped
   * entirely. 'mild': recited with some elongation, just short of the rule's minimum. */
  severity: 'mild' | 'severe'
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function detectMaddDurationAlerts(
  aligned: AlignedWord[],
  referenceWords: WordWithRules[],
  chunks: TimedChunk[],
  correctRefIndices: Set<number>,
): AcousticAlert[] {
  if (chunks.length < 3) return []

  const durations = chunks
    .map((c) => (typeof c.timestamp?.[1] === 'number' ? c.timestamp[1] - c.timestamp[0] : 0))
    .filter((d) => d > 0)
  if (durations.length < 3) return []

  const baseline = median(durations)
  if (baseline <= 0) return []

  const alerts: AcousticAlert[] = []
  for (const w of aligned) {
    if (w.refIndex === null || w.hypIndex === null) continue
    if (!correctRefIndices.has(w.refIndex)) continue
    const refWord = referenceWords[w.refIndex]
    const maddRule = refWord?.rules.find((r) => r in MADD_MIN_RELATIVE_DURATION)
    if (!maddRule) continue

    const chunk = chunks[w.hypIndex]
    const end = chunk?.timestamp?.[1]
    const start = chunk?.timestamp?.[0]
    if (typeof end !== 'number' || typeof start !== 'number') continue

    const duration = end - start
    const expectedMin = baseline * MADD_MIN_RELATIVE_DURATION[maddRule]!
    if (duration < expectedMin) {
      alerts.push({
        refIndex: w.refIndex,
        word: refWord.word,
        rule: maddRule,
        durationMs: duration * 1000,
        expectedMinMs: expectedMin * 1000,
        severity: duration <= baseline ? 'severe' : 'mild',
      })
    }
  }
  return alerts
}
