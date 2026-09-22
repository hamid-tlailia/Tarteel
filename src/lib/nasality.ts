import type { WordWithRules } from './tajweed'
import type { TajweedRuleId } from '../types/quran'
import { GHUNNA_RULES } from './wordTiming'
import { analyzeSpan, type SpanTimbre } from './spectral'

/**
 * Does the nasal sound a ghunnah calls for actually appear in the recording?
 *
 * The duration checks in acousticTajweed.ts cannot answer this. A ghunnah adds about two
 * ḥarakāt, and on a short word that is comparable to the error in the word boundaries
 * themselves: «عَمَّ» recited deliberately without its ghunnah came in at 520ms against a
 * physical floor of 570ms, ten milliseconds inside measurement tolerance. No threshold on
 * length could have caught it without also accusing reciters who are merely quick. The
 * nasal murmur, though, looks nothing like a vowel — see spectral.ts.
 *
 * Every number here is relative to the same reciter in the same recording. Absolute levels
 * depend on the microphone, the room and the voice, so the only meaningful question is
 * whether the words that should be nasal are more nasal than the words that should not.
 */

/**
 * How far above the reciter's own non-nasal words a ghunnah must stand.
 *
 * Reasoned, not calibrated against recordings — there is no corpus here to fit it to. A
 * synthesised murmur sits about 22dB above an open /a/ and about 14dB above a close /u/,
 * the vowel most easily mistaken for it, so 6dB asks for clearly more nasality than the
 * roundest vowel while leaving plenty of room for a quiet or muffled recording. The
 * measured values are reported in the diagnostics panel whether or not an alert fires, so
 * a real attempt on a real device can move this number off guesswork.
 */
const NASAL_MARGIN_DB = 6
/** Below this, the nasal sound is not merely weak — nothing nasal happened at all. */
const NASAL_ABSENT_MARGIN_DB = 1
/**
 * How many non-nasal words the recording must offer before the comparison means anything.
 *
 * One. The temptation is to demand a few, but an earlier version of the duration check
 * required three words and so silently examined nothing at all on a two-word ayah — which
 * is exactly the shape of «عَمَّ يَتَسَآءَلُونَ», the case this whole check exists for. A
 * single word is a noisy yardstick, and the answer to that is the wide margin above, not
 * refusing to look.
 */
const MIN_BASELINE_WORDS = 1
/** A span measured over fewer frames than this is too brief to trust. */
const MIN_FRAMES = 8

/**
 * A nūn or mīm carrying a sukūn or a shadda is held, and so sounds nasal whether or not the
 * edition marked a rule on it — such a word cannot serve as an example of how this reciter
 * sounds when *not* nasalising.
 *
 * Only that narrow case. Excluding every word containing a nūn or a mīm at all was the first
 * attempt, and it emptied the baseline on ordinary Arabic: «يَتَسَآءَلُونَ» ends in a nūn, so
 * the one ayah this check was written for had nothing left to compare against. A moving nūn
 * is a brief release, not a murmur, and leaving it in only raises the bar the ghunnah must
 * clear — an error in the forgiving direction.
 */
const HELD_NASAL = /[نم][\u0651\u0652]/

export interface TimbreMeasurement extends SpanTimbre {
  refIndex: number
}

export interface NasalityAlert {
  refIndex: number
  word: string
  rule: TajweedRuleId
  measuredDb: number
  /** What this reciter's non-nasal words measured, for context in the diagnostics. */
  baselineDb: number
  requiredDb: number
  /** 'severe': no more nasal than an ordinary vowel from the same voice. */
  severity: 'mild' | 'severe'
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function ghunnahRuleOf(rules: TajweedRuleId[]): TajweedRuleId | undefined {
  return rules.find((r) => GHUNNA_RULES.has(r))
}

/** Measures every word that has a timing. Kept separate from judging them so the raw
 * numbers can be shown even when nothing is reported. */
export function measureWordTimbre(
  audio: Float32Array,
  sampleRate: number,
  wordTimings: ([number, number] | null)[],
): (TimbreMeasurement | null)[] {
  return wordTimings.map((timing, refIndex) => {
    if (!timing) return null
    const timbre = analyzeSpan(audio, sampleRate, timing[0], timing[1])
    return timbre.voicedFrames >= MIN_FRAMES ? { refIndex, ...timbre } : null
  })
}

/**
 * Reports ghunnah-carrying words whose sound is no more nasal than this reciter's own
 * ordinary vowels. Returns nothing — never a fault — when the recording gives no usable
 * baseline to compare against.
 */
export function detectGhunnahNasalityAlerts(
  referenceWords: WordWithRules[],
  measurements: (TimbreMeasurement | null)[],
  correctRefIndices: Set<number>,
): NasalityAlert[] {
  const baseline: number[] = []
  referenceWords.forEach((refWord, i) => {
    const m = measurements[i]
    if (!m) return
    if (ghunnahRuleOf(refWord.rules)) return
    if (HELD_NASAL.test(refWord.word)) return
    baseline.push(m.peakNasalDb)
  })
  if (baseline.length < MIN_BASELINE_WORDS) return []

  const baselineDb = median(baseline)
  const requiredDb = baselineDb + NASAL_MARGIN_DB

  const alerts: NasalityAlert[] = []
  referenceWords.forEach((refWord, i) => {
    if (!correctRefIndices.has(i)) return
    const rule = ghunnahRuleOf(refWord.rules)
    if (!rule) return
    const m = measurements[i]
    if (!m) return
    if (m.peakNasalDb >= requiredDb) return
    alerts.push({
      refIndex: i,
      word: refWord.word,
      rule,
      measuredDb: m.peakNasalDb,
      baselineDb,
      requiredDb,
      severity: m.peakNasalDb <= baselineDb + NASAL_ABSENT_MARGIN_DB ? 'severe' : 'mild',
    })
  })
  return alerts
}
