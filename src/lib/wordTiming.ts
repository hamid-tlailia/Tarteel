import type { TajweedRuleId } from '../types/quran'
import type { WordWithRules } from './tajweed'

/**
 * Theory-grounded (rule + syllable count) *absolute* expected word duration, used by the
 * live RMS-based tracker (see liveTracker.ts) to give instant per-word timing feedback while
 * recording — before any ASR pass has run. Unlike the post-hoc checks in acousticTajweed.ts,
 * which compare a word's measured duration against *this specific recording's own* median
 * word duration (and so need a few already-confirmed-correct words to calibrate against),
 * this is derived purely from the word's own syllable count and tajweed rules, so it works
 * from the very first word.
 *
 * The harakah-based constants mirror the widely used pedagogical convention for a measured
 * "tarteel" pace (natural madd = 2 harakāt, wājib muttaṣil/jā'iz munfaṣil ≈ 4, lāzim = 6) —
 * the same scale already used for the relative multipliers in acousticTajweed.ts.
 */
const HARAKA_MS = 260
const WORD_FIXED_MS = 70
const MIN_WORD_MS = 240
const QALQALAH_BOUNCE_MS = 90

/**
 * The *shortest* length each madd permits, in ḥarakāt — not a typical or middle length.
 *
 * A reciter who takes the shortest permitted option has done nothing wrong, so measuring
 * against anything longer manufactures faults. That matters most for the ʿāriḍ, where two,
 * four and six are all sound: requiring four flagged a perfectly valid qaṣr as "short" on
 * nearly every ayah-final word, since almost every ayah ends in one. Where Ḥafṣ permits
 * four or five (muttaṣil, munfaṣil), four is the floor.
 */
const MADD_HARAKAT: Partial<Record<TajweedRuleId, number>> = {
  madda_normal: 2,
  madda_permissible: 4,
  madda_obligatory: 4,
  madda_necessary: 6,
  // Derived from the script rather than marked by the edition — see uthmaniRules.ts.
  madda_badal: 2,
  madda_sila_sughra: 2,
  madda_sila_kubra: 4,
  madda_leen: 2,
  // Permits 2, 4 or 6 — and joining onward rather than stopping amounts to the natural 2.
  madda_arid: 2,
  madda_iwad: 2,
}

/** Madds whose length the reciter may freely extend beyond the minimum above, and by how
 * many further ḥarakāt at most. Time spent here is a choice, never an obligation. */
const MADD_OPTIONAL_EXTRA_HARAKAT: Partial<Record<TajweedRuleId, number>> = {
  madda_arid: 4, // 2 required, up to 6 permitted
  madda_leen: 4, // follows the ʿāriḍ it accompanies
}

const GHUNNA_RULES = new Set<TajweedRuleId>([
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

export interface FastestPlausible {
  /** The least time the word's ordinary syllables could occupy. */
  baseMs: number
  /** The least time its held obligation could occupy, if performed at all. */
  holdMs: number
}

/** The fastest this word could physically be recited with its hold actually performed. */
export function fastestPlausibleDuration(w: WordWithRules, kind: 'madd' | 'ghunnah'): FastestPlausible {
  let harakat = 0
  for (const rule of w.rules) {
    if (kind === 'madd') harakat += MADD_HARAKAT[rule] ?? 0
    else if (GHUNNA_RULES.has(rule)) harakat += GHUNNA_HARAKAT
  }
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

export function expectedDurationBreakdown(w: WordWithRules): ExpectedDuration {
  const base = WORD_FIXED_MS + HARAKA_MS * countSyllables(w.word)
  let maddMs = 0
  let ghunnaMs = 0
  let otherMs = 0
  let optionalMs = 0
  for (const rule of w.rules) {
    const harakat = MADD_HARAKAT[rule]
    if (harakat) maddMs += harakat * HARAKA_MS
    const extra = MADD_OPTIONAL_EXTRA_HARAKAT[rule]
    if (extra) optionalMs += extra * HARAKA_MS
    if (GHUNNA_RULES.has(rule)) ghunnaMs += GHUNNA_HARAKAT * HARAKA_MS
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

export function expectedWordDurationMs(w: WordWithRules): number {
  return expectedDurationBreakdown(w).total
}
