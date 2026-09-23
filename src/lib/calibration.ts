import type { TajweedRuleId } from '../types/quran'
import type { WordWithRules } from './tajweed'
import { impliedHeldHarakat, wordShape, GHUNNA_RULES } from './wordTiming'
import { detectPace, maddHarakatAt, paceOf, type PaceId } from './recitationPace'
import { heldRulesOf } from './ruleMeter'
import { auditHeldRulesForced } from './acousticTajweed'

/**
 * Measuring the constants against recitations that are correct by construction.
 *
 * The madd measures in recitationPace.ts are read off the books: a lāzim is six ḥarakāt, a
 * ḥaraka is about 260ms in tadwīr. Both statements are defensible and neither is a
 * measurement, and the second one especially is a guess — nobody tells a reciter how many
 * milliseconds a ḥaraka lasts.
 *
 * Published word-level timings for accredited reciters let both be measured instead. And they
 * give something more valuable still: **every word of an accredited recitation is a
 * labelled-correct example**. No teacher has to sit down with it. So any fault this app raises
 * against al-Ḥuṣarī reading al-Nabaʾ is a false alarm by construction, and the false-alarm
 * rate — the error that costs a learner's trust — becomes measurable at scale today.
 *
 * What this cannot measure is what the app *misses*: a corpus of correct recitation contains
 * no mistakes, so it says nothing about faults passed over. That half still needs recordings
 * with known errors.
 */

export interface WordSample {
  /** Which published recitation this came from. */
  reciter: string
  /** Where in the passage, for reporting a disagreement back. */
  ayahKey: string
  word: WordWithRules
  measuredMs: number
}

export interface HarakaEstimate {
  reciter: string
  /** From words carrying no held ruling, so the thing being measured never sets its own scale. */
  harakaMs: number
  samples: number
  /** The pace this speed corresponds to, by the app's own classification. */
  paceId: PaceId
}

export interface RuleMeasurement {
  rule: TajweedRuleId
  /** Words where this was the *only* held ruling — the rest cannot be attributed. */
  samples: number
  /** Measured held ḥarakāt: the median, and the range accredited reciters actually span. */
  medianHarakat: number
  p10Harakat: number
  p90Harakat: number
  /** What this build asks for at each reciter's own pace, for comparison. */
  expectedHarakat: number
  reciters: number
}

export interface FalseAlarmScan {
  reciter: string
  paceId: PaceId
  wordsWithRulings: number
  /** Faults raised against a recitation that is correct by construction. */
  falseAlarms: { ayahKey: string; word: string; rule: TajweedRuleId; severity: string }[]
  undecided: number
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const low = Math.floor(pos)
  const high = Math.ceil(pos)
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (pos - low)
}

const median = (values: number[]) => quantile([...values].sort((a, b) => a - b), 0.5)

/** Whether a word carries any held obligation at all — such words cannot set the ḥaraka. */
export function hasHeldRule(word: WordWithRules, paceId?: PaceId): boolean {
  const pace = paceOf(paceId)
  return word.rules.some((rule) => maddHarakatAt(pace, rule) > 0 || GHUNNA_RULES.has(rule))
}

/**
 * One reciter's ḥaraka, from their own plain words.
 *
 * Held words are excluded for the same reason they are excluded everywhere else in this
 * codebase: letting the sound under examination set the yardstick is how a correctly held madd
 * comes to look short.
 */
export function estimateHaraka(reciter: string, samples: WordSample[]): HarakaEstimate | null {
  const estimates: number[] = []
  for (const sample of samples) {
    if (hasHeldRule(sample.word)) continue
    // A plain word is the model's fixed overhead plus one ḥaraka per syllable, so its ḥaraka
    // falls straight out of its duration. Both numbers come from the model itself (wordShape)
    // rather than being recounted here, so this measures the thing the app actually uses.
    const { fixedMs, syllables } = wordShape(sample.word)
    if (syllables <= 0) continue
    const harakaMs = (sample.measuredMs - fixedMs) / syllables
    if (harakaMs > 40 && harakaMs < 900) estimates.push(harakaMs)
  }
  if (estimates.length === 0) return null
  const harakaMs = median(estimates)
  return { reciter, harakaMs, samples: estimates.length, paceId: detectPace(harakaMs).id }
}

/**
 * How long each ruling is actually held, in ḥarakāt, across reciters.
 *
 * Only words whose held obligation is a single marking are used. A word carrying two madds has
 * one duration and two obligations, and splitting it between them would invent a measurement.
 */
export function measureRules(
  samples: WordSample[],
  harakaByReciter: Map<string, HarakaEstimate>,
): RuleMeasurement[] {
  const byRule = new Map<TajweedRuleId, { harakat: number[]; reciters: Set<string>; expected: number[] }>()
  for (const sample of samples) {
    const haraka = harakaByReciter.get(sample.reciter)
    if (!haraka) continue
    const marks = heldRulesOf(sample.word, haraka.paceId)
    if (marks.length !== 1) continue
    const held = impliedHeldHarakat(sample.word, sample.measuredMs, haraka.harakaMs)
    if (held === null) continue
    const rule = marks[0].rule
    const entry = byRule.get(rule) ?? { harakat: [], reciters: new Set<string>(), expected: [] }
    entry.harakat.push(held)
    entry.reciters.add(sample.reciter)
    entry.expected.push(marks[0].requiredMs / haraka.harakaMs)
    byRule.set(rule, entry)
  }

  return [...byRule.entries()]
    .map(([rule, entry]) => {
      const sorted = [...entry.harakat].sort((a, b) => a - b)
      return {
        rule,
        samples: sorted.length,
        medianHarakat: quantile(sorted, 0.5),
        p10Harakat: quantile(sorted, 0.1),
        p90Harakat: quantile(sorted, 0.9),
        expectedHarakat: median(entry.expected),
        reciters: entry.reciters.size,
      }
    })
    .sort((a, b) => b.samples - a.samples)
}

/**
 * Runs the app's own duration audit over an accredited recitation.
 *
 * Every word here was recited by a muqriʾ whose reading is published as a reference, so every
 * fault raised is a false alarm and every one is a bug. The pace is the one the reciter is
 * actually reading in, which is what the app tells a learner to select.
 */
export function scanForFalseAlarms(
  reciter: string,
  samples: WordSample[],
  haraka: HarakaEstimate,
  paceId: PaceId = haraka.paceId,
): FalseAlarmScan {
  const words = samples.map((s) => s.word)
  // The audit wants second-precision spans; lay each word out end to end, since it only ever
  // measures a word's own length.
  let cursor = 0
  const timings = samples.map((s): [number, number] => {
    const start = cursor
    cursor += s.measuredMs / 1000 + 0.2
    return [start, start + s.measuredMs / 1000]
  })
  const all = new Set(samples.map((_, i) => i))
  const checks = auditHeldRulesForced(words, timings, all, paceId, null)
  return {
    reciter,
    paceId,
    wordsWithRulings: new Set(checks.filter((c) => c.kind).map((c) => c.refIndex)).size,
    falseAlarms: checks
      .filter((c) => c.outcome === 'short' || c.outcome === 'absent')
      .map((c) => ({
        ayahKey: samples[c.refIndex]?.ayahKey ?? '?',
        word: samples[c.refIndex]?.word.word ?? '',
        rule: c.rules[0],
        severity: c.outcome,
      })),
    undecided: checks.filter((c) => c.outcome === 'undecided' && c.reason !== 'not-isolated').length,
  }
}
