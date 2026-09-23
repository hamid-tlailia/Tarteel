import type { TajweedRuleId, TajweedSegment } from '../types/quran'
import { FFT_SIZE, HoldTracker } from './holdDetector'
import { maddHarakatAt, paceOf, type PaceId } from './recitationPace'
import { GHUNNA_RULES } from './wordTiming'

/**
 * The smallest useful exercise: say this one word, and be told how long you held it.
 *
 * A lesson that only explains a ruling and then asks its name has taught a definition. What a
 * learner needs is to *do* it and find out whether they did — and for a madd or a ghunnah, that
 * is a question a phone can actually answer, because the whole exercise is one short word with
 * one obligation in it. No alignment is needed and no model: there is nothing to align, so the
 * longest sustained sound in the clip is the hold, and its length is the answer.
 *
 * What this deliberately does not do is judge the word. It cannot tell whether the right letters
 * were said, whether the makhraj was sound, or whether the learner recited something else
 * entirely — so it reports a length and says that is all it measured.
 */

const GHUNNA_HARAKAT = 2
const HOP_MS = 20

export interface DrillTarget {
  /** The word to recite, without markup. */
  word: string
  /** The segments of that word, so the target letters can still be coloured. */
  segments: TajweedSegment[]
  rule: TajweedRuleId
  /** Where the example came from, so a learner can go and read it in context. */
  surah: number
  ayah: number
}

/** How many ḥarakāt this ruling asks to be held, or 0 when it is not a held ruling at all. */
export function heldHarakatOf(rule: TajweedRuleId, paceId?: PaceId): number {
  const madd = maddHarakatAt(paceOf(paceId), rule)
  if (madd > 0) return madd
  return GHUNNA_RULES.has(rule) ? GHUNNA_HARAKAT : 0
}

export interface DrillMeasurement {
  /** The longest sustained sound found, in ms, and in ḥarakāt at this pace. */
  heldMs: number
  harakat: number
  requiredHarakat: number
  /** Whether that sound came out of the nose — the difference between a ghunnah and a vowel.
   * Null where there was no oral sound in the clip to compare it against. */
  nasal: boolean | null
  /** True when nothing steady was found at all: either nothing was held, or nothing was said. */
  silent: boolean
}

/**
 * Measures the longest held sound in a short clip.
 *
 * The clip is assumed to be one word, so the hold that matters is simply the longest one — there
 * is no ruling order to respect and nothing to attribute. That is what makes this honest on a
 * two-ḥaraka madd, where a whole word's duration is not evidence: two ḥarakāt of sustained sound
 * are hundreds of milliseconds, and those are visible whatever the word's edges are doing.
 */
export function measureDrill(
  audio: Float32Array,
  sampleRate: number,
  rule: TajweedRuleId,
  paceId?: PaceId,
): DrillMeasurement {
  const requiredHarakat = heldHarakatOf(rule, paceId)
  const harakaMs = paceOf(paceId).harakaMs
  const hop = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate))
  const tracker = new HoldTracker()
  for (let at = 0; at + FFT_SIZE <= audio.length; at += hop) {
    tracker.feed(audio.subarray(at, at + FFT_SIZE), sampleRate, HOP_MS)
  }
  const holds = tracker.finish()
  const longest = holds.reduce<{ startMs: number; endMs: number; nasal: boolean | null } | null>(
    (best, h) => (!best || h.endMs - h.startMs > best.endMs - best.startMs ? h : best),
    null,
  )
  const heldMs = longest ? longest.endMs - longest.startMs : 0
  return {
    heldMs: Math.round(heldMs),
    harakat: harakaMs > 0 ? heldMs / harakaMs : 0,
    requiredHarakat,
    nasal: longest?.nasal ?? null,
    silent: heldMs === 0,
  }
}

/** The share of the obligation below which the hold counts as not performed. */
const ABSENT_BELOW = 0.25
/** How much of it must be there before it passes — the same allowance the results card makes. */
const ENOUGH = 0.75

export type DrillVerdict = 'met' | 'short' | 'absent' | 'undecided'

export function judgeDrill(measurement: DrillMeasurement): { verdict: DrillVerdict; reasonAr?: string } {
  if (measurement.requiredHarakat <= 0) {
    return { verdict: 'undecided', reasonAr: 'هذا الحكم لا يُقاس بطول الصوت، فاستمع وقارن' }
  }
  if (measurement.silent) return { verdict: 'undecided', reasonAr: 'لم نسمع صوتًا ممتدًّا — اقترب من الميكروفون وأعد' }
  const performed = measurement.harakat / measurement.requiredHarakat
  if (performed >= ENOUGH) return { verdict: 'met' }
  if (performed <= ABSENT_BELOW) return { verdict: 'absent' }
  return { verdict: 'short' }
}

/** Pulls the shortest word that carries the rule out of an example ayah — the phrase to drill. */
export function drillTargetFrom(
  segments: TajweedSegment[],
  rule: TajweedRuleId,
  surah: number,
  ayah: number,
): DrillTarget | null {
  // Walk the ayah letter by letter, splitting on spaces, and keep the word the rule falls in.
  const words: { text: string; segments: TajweedSegment[]; hasRule: boolean }[] = []
  let current = { text: '', segments: [] as TajweedSegment[], hasRule: false }
  for (const seg of segments) {
    for (const ch of seg.text) {
      if (/\s/.test(ch)) {
        if (current.text) words.push(current)
        current = { text: '', segments: [], hasRule: false }
        continue
      }
      current.text += ch
      const last = current.segments[current.segments.length - 1]
      if (last && last.rule === seg.rule) last.text += ch
      else current.segments.push({ text: ch, rule: seg.rule })
      if (seg.rule === rule) current.hasRule = true
    }
  }
  if (current.text) words.push(current)

  const carrying = words.filter((w) => w.hasRule)
  if (carrying.length === 0) return null
  // The shortest one: a drill is a single word said once, and the shorter it is the more of the
  // learner's attention lands on the ruling itself.
  const chosen = carrying.reduce((best, w) => (w.text.length < best.text.length ? w : best))
  return { word: chosen.text, segments: chosen.segments, rule, surah, ayah }
}
