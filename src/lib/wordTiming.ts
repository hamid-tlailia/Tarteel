import type { TajweedRuleId } from '../types/quran'
import type { WordWithRules } from './tajweed'
import { maddHarakatAt, maddOptionalExtraAt, paceOf, type PaceId, type PaceProfile } from './recitationPace'

/**
 * Theory-grounded (rule + syllable count) *absolute* expected word duration, used by the
 * live RMS-based tracker (see liveTracker.ts) to give instant per-word timing feedback while
 * recording — before any ASR pass has run. Unlike the post-hoc checks in acousticTajweed.ts,
 * which compare a word's measured duration against *this specific recording's own* median
 * word duration (and so need a few already-confirmed-correct words to calibrate against),
 * this is derived purely from the word's own syllable count and tajweed rules, so it works
 * from the very first word.
 *
 * How long a ḥaraka lasts, and how many ḥarakāt each madd is owed, both belong to the pace
 * the reciter chose — see recitationPace.ts. A single fixed tempo had to treat every reciter
 * faster or slower than it as mistaken, and had to pick one reading of the ʿāriḍ (two, four
 * or six are all sound) and call the other two faults. Callers that name no pace get tadwīr,
 * the middle one, which is what this file assumed before paces existed.
 */
const WORD_FIXED_MS = 70
const MIN_WORD_MS = 240
const QALQALAH_BOUNCE_MS = 90

/** Rules performed as a held nasal sound. Shared with the checks that measure it. */
export const GHUNNA_RULES = new Set<TajweedRuleId>([
  'ghunnah',
  'ikhafa',
  'ikhafa_shafawi',
  'idgham_ghunnah',
  'iqlab',
])
const GHUNNA_HARAKAT = 2

// Short vowels (fatha/damma/kasra) and tanween marks — each is one syllable beat.
const SYLLABLE_MARKS = /[ًٌٍَُِ]/g

function countSyllables(word: string): number {
  const marks = word.match(SYLLABLE_MARKS)
  return Math.max(1, marks ? marks.length : 0)
}

/**
 * Floors on how fast a thing can physically be recited, used for a pace-independent check.
 *
 * A pace-relative test asks whether one word is out of line with the others, so it is blind
 * by construction to a *uniform* failure: if every obligation in a passage is skipped alike,
 * nothing stands out. These bounds answer a different question — could this word have
 * contained its hold at all, at the fastest anyone plausibly recites? Deliberately extreme,
 * so a merely quick reciter never trips them.
 */
const FASTEST_SYLLABLE_MS = 100
/** A madd or ghunnah ḥaraka is a *held* sound, so it floors higher than a clipped syllable. */
const FASTEST_HELD_HARAKA_MS = 150

/**
 * The ḥarakāt a word's held rules actually add, counted per *letter* rather than per rule.
 *
 * Several rulings can describe the same letter. An ayah-final «ٱلضَّآلِّينَ» is marked by the
 * edition with a necessary madd on its alif and a "permissible" madd on its yāʾ, and this
 * engine derives a madd ʿāriḍ on that same yāʾ. Adding the three up charged the word twelve
 * ḥarakāt where eight are owed, so a reciter who held it correctly measured barely half the
 * required duration and was told they had shortened it — Sūrat al-Fātiḥah ended in a false
 * fault on its last word, every time.
 *
 * Rules are therefore grouped by the letters they cover. Rules on genuinely separate letters
 * still add up (that alif and that yāʾ are two holds, not one). Within a group, the required
 * length is the *shortest* any applicable ruling permits: the edition's broad "permissible
 * madd" code covers the munfaṣil, the ʿāriḍ and the līn alike, so when the derivation engine
 * identifies which one it actually is, that more specific ruling decides the floor — and a
 * reciter taking the shortest reading a ruling allows has done nothing wrong. The optional
 * stretch beyond that floor is taken the other way round, as the most any of them permits.
 *
 * Without span information (hand-built words, fixtures) every rule is assumed to describe the
 * same letter, which is the forgiving reading: under-counting only makes the check more
 * lenient, whereas over-counting invents faults.
 */
function heldHarakat(
  w: WordWithRules,
  harakatOf: (rule: TajweedRuleId) => number,
  combine: 'shortest' | 'longest',
  /**
   * Ḥarakāt of each held letter that the word's ordinary syllables already account for.
   *
   * One, for a madd. A madd letter *is* the vowel of its syllable, lengthened: «قَالَ» is two
   * syllables of which the first is held for two ḥarakāt, not two syllables plus two more. The
   * model charged both, so every madd word was predicted one ḥaraka too long, and a reciter who
   * performed it correctly came in short.
   *
   * The evidence is direct. Fitting this model to word timings from nine published Ḥafṣ
   * recitations (~6,400 words) gives the ḥarakāt each ruling actually adds above the syllable
   * baseline: madd ṭabīʿī 1.0 against the two the books name, wājib muttaṣil 3.0 against four,
   * ʿāriḍ 2.0 — each of them exactly one ḥaraka less than asked. Deducting that shared beat is
   * not a tolerance, it is the overlap the model was missing.
   */
  overlapPerLetter = 0,
): number {
  const pick = combine === 'shortest' ? Math.min : Math.max
  const byRule = w.rules.map((rule) => ({ rule, harakat: harakatOf(rule) })).filter((r) => r.harakat > 0)
  if (byRule.length === 0) return 0

  // Counted per *marking*, not per rule. The same rule on two different letters is two
  // obligations: «الٓمٓ» carries a madd lāzim on its lām and another on its mīm — twelve
  // ḥarakāt in all — and counting the rule once charged the word six. Going through the rule
  // list first also made a word with a single rule return early, never reaching the spans at
  // all, which is how that word slipped through.
  const marks = (w.spans ?? [])
    .map((span) => ({ ...span, harakat: harakatOf(span.rule) }))
    .filter((m) => m.harakat > 0)

  // Without spans (hand-built words, fixtures) there is nothing to say whether the rules sit
  // on one letter or several, so they are assumed to share one — the forgiving reading.
  const deduct = (harakat: number) => Math.max(0, harakat - overlapPerLetter)
  if (marks.length === 0 || byRule.some((r) => !marks.some((m) => m.rule === r.rule))) {
    return deduct(byRule.length === 1 ? byRule[0].harakat : pick(...byRule.map((r) => r.harakat)))
  }

  // Cluster the markings by letters that touch, then resolve each cluster to a single hold.
  const groups: { start: number; end: number; harakat: number }[] = []
  for (const mark of marks) {
    const overlapping = groups.filter((g) => mark.start < g.end && g.start < mark.end)
    const merged = {
      start: Math.min(mark.start, ...overlapping.map((g) => g.start)),
      end: Math.max(mark.end, ...overlapping.map((g) => g.end)),
      harakat: overlapping.length === 0 ? mark.harakat : pick(mark.harakat, ...overlapping.map((g) => g.harakat)),
    }
    for (const g of overlapping) groups.splice(groups.indexOf(g), 1)
    groups.push(merged)
  }
  return groups.reduce((sum, g) => sum + deduct(g.harakat), 0)
}

/** The ḥaraka a held letter shares with the syllable it belongs to — see heldHarakat. */
const MADD_SYLLABLE_OVERLAP = 1

/**
 * The parts of a word's duration that do not depend on the pace: its fixed overhead and how
 * many ordinary syllable beats it has.
 *
 * Exported so real recitations can be measured against the same model the app judges by. The
 * alternative was a measuring script with its own copy of `WORD_FIXED_MS` and its own syllable
 * counter, which would calibrate constants for a model no reciter runs.
 */
export function wordShape(w: WordWithRules): { fixedMs: number; syllables: number } {
  return { fixedMs: WORD_FIXED_MS, syllables: countSyllables(w.word) }
}

/**
 * How many ḥarakāt of *held* sound a measured duration implies, given how long one ḥaraka
 * lasts for this reciter.
 *
 * The inverse of the model in expectedDurationBreakdown: a word takes a fixed overhead, plus
 * one ḥaraka per ordinary syllable, plus however many ḥarakāt its rules are held for. Run
 * over accredited recitations whose word timings are published, it answers the question the
 * constants in recitationPace.ts can only assert: how long *is* a madd lāzim, in practice,
 * for a reciter reading at this speed.
 *
 * Returns null when the reciter's ḥaraka is unknown or the word is shorter than its own
 * syllables — a measurement that cannot be interpreted rather than one worth reporting.
 */
export function impliedHeldHarakat(w: WordWithRules, measuredMs: number, harakaMs: number): number | null {
  if (!(harakaMs > 0) || !(measuredMs > 0)) return null
  const { fixedMs, syllables } = wordShape(w)
  const held = (measuredMs - fixedMs) / harakaMs - syllables
  return held >= -syllables ? held : null
}

export interface FastestPlausible {
  /** The least time the word's ordinary syllables could occupy. */
  baseMs: number
  /** The least time its held obligation could occupy, if performed at all. */
  holdMs: number
}

/** The fastest this word could physically be recited with its hold actually performed. */
export function fastestPlausibleDuration(
  w: WordWithRules,
  kind: 'madd' | 'ghunnah',
  paceId?: PaceId,
): FastestPlausible {
  const pace = paceOf(paceId)
  const harakat = heldHarakat(
    w,
    (rule) => (kind === 'madd' ? maddHarakatAt(pace, rule) : GHUNNA_RULES.has(rule) ? GHUNNA_HARAKAT : 0),
    'shortest',
    kind === 'madd' ? MADD_SYLLABLE_OVERLAP : 0,
  )
  return {
    baseMs: WORD_FIXED_MS + countSyllables(w.word) * FASTEST_SYLLABLE_MS,
    holdMs: harakat * FASTEST_HELD_HARAKA_MS,
  }
}

export interface ExpectedDuration {
  /** How long the word should take when every rule in it is given its due, each at the
   * shortest length it permits — the bar a recitation must clear, not an ideal. */
  total: number
  /** Further time the reciter *may* take, extending a madd that permits more than its
   * minimum (the ʿāriḍ above all). Never owed, so the meter shows it past the finish line
   * rather than inside it, and no shortfall is ever measured against it. */
  optionalExtraMs: number
  /** How long the same word would take if its madd letters were *not* elongated at all —
   * the floor below which "the madd is missing entirely" is a fair thing to say. Equal to
   * `total` for words carrying no madd. */
  withoutMadd: number
  /** The same, for a word judged on its ghunnah: how long it would take with the nasal
   * sound not held at all. Equal to `total` for words carrying no ghunnah. */
  withoutGhunnah: number
}

export function expectedDurationBreakdown(w: WordWithRules, paceId?: PaceId): ExpectedDuration {
  const pace = paceOf(paceId)
  const harakaMs = pace.harakaMs
  const base = WORD_FIXED_MS + harakaMs * countSyllables(w.word)
  const maddMs = heldHarakat(w, (rule) => maddHarakatAt(pace, rule), 'shortest', MADD_SYLLABLE_OVERLAP) * harakaMs
  const ghunnaMs = heldHarakat(w, (rule) => (GHUNNA_RULES.has(rule) ? GHUNNA_HARAKAT : 0), 'shortest') * harakaMs
  // The optional stretch belongs to the same letter as the madd it extends, so it is chosen
  // the same way: the most any one of the word's madds permits beyond its minimum.
  const optionalMs = heldHarakat(w, (rule) => maddOptionalExtraAt(pace, rule), 'longest') * harakaMs
  let otherMs = 0
  for (const rule of w.rules) {
    if (rule === 'qalqalah') otherMs += QALQALAH_BOUNCE_MS
  }
  const floor = (ms: number) => Math.max(MIN_WORD_MS, Math.round(ms))
  return {
    total: floor(base + maddMs + ghunnaMs + otherMs),
    optionalExtraMs: Math.round(optionalMs),
    withoutMadd: floor(base + ghunnaMs + otherMs),
    withoutGhunnah: floor(base + maddMs + otherMs),
  }
}

export function expectedWordDurationMs(w: WordWithRules, paceId?: PaceId): number {
  return expectedDurationBreakdown(w, paceId).total
}

/**
 * How long a ḥaraka lasted in the recitation just measured, from how a word's duration
 * compares with what its own syllables and rules called for. Feeds the pace actually read in
 * back to the reciter (see detectPace) instead of only judging them against the one they
 * picked.
 */
export function measuredHarakaMs(w: WordWithRules, measuredMs: number, paceId?: PaceId): number | null {
  const pace = paceOf(paceId)
  const expected = expectedDurationBreakdown(w, paceId)
  if (expected.total <= 0 || measuredMs <= 0) return null
  return (measuredMs / expected.total) * pace.harakaMs
}

export type { PaceProfile }
