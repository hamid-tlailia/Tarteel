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

const MADD_HARAKAT: Partial<Record<TajweedRuleId, number>> = {
  madda_normal: 2,
  madda_permissible: 4,
  madda_obligatory: 4.5,
  madda_necessary: 6,
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

export function expectedWordDurationMs(w: WordWithRules): number {
  let ms = WORD_FIXED_MS + HARAKA_MS * countSyllables(w.word)
  for (const rule of w.rules) {
    const harakat = MADD_HARAKAT[rule]
    if (harakat) ms += harakat * HARAKA_MS
    if (GHUNNA_RULES.has(rule)) ms += GHUNNA_HARAKAT * HARAKA_MS
    if (rule === 'qalqalah') ms += QALQALAH_BOUNCE_MS
  }
  return Math.max(MIN_WORD_MS, Math.round(ms))
}
