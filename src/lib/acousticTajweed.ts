import type { WordWithRules } from './tajweed'
import type { TajweedRuleId } from '../types/quran'
import type { AlignedWord } from './alignment'
import type { TimedChunk } from '../asr/whisper.worker'
import { expectedDurationBreakdown, fastestPlausibleDuration } from './wordTiming'

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
  // Derived from the script rather than marked by the edition — see uthmaniRules.ts. Their
  // duration is checkable exactly like the marked madds', so they are verified the same way.
  'madda_badal',
  'madda_sila_sughra',
  'madda_sila_kubra',
  'madda_leen',
  'madda_arid',
  'madda_iwad',
])

/** Rules whose performance is a held nasal sound of about two ḥarakāt. Their duration is
 * checkable the same way a madd's is, and until now it fed the expected duration of a word
 * without ever being verified on its own — only madd raised an alert, so a clipped ghunnah
 * in a word carrying no madd went unreported. */
const GHUNNA_RULES = new Set<TajweedRuleId>([
  'ghunnah',
  'ikhafa',
  'ikhafa_shafawi',
  'idgham_ghunnah',
  'iqlab',
])

/**
 * How much of the hold a rule demands must actually be performed before it passes.
 *
 * Measured against the *obligation itself* — the extra time the rule adds to the word —
 * rather than against the word's whole duration. A flat percentage of the total was too
 * blunt: on a long word like «ءَامَنَّا», three syllables of base duration meant that dropping
 * the madd entirely shortened the word by only about a quarter, which slipped under a 30%
 * tolerance and went unreported. Judging the obligation directly makes detection
 * independent of how long the surrounding word happens to be.
 */
const HOLD_FULFILLED_ENOUGH = 0.6
/** Below this share of the obligation, the sound was effectively never held at all. */
const HOLD_ABSENT_BELOW = 0.2

/** Word timings come from the ASR at roughly 20ms resolution; allow a few frames either way
 * before calling a duration physically impossible. */
const TIMING_TOLERANCE_MS = 60

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export interface AcousticAlert {
  refIndex: number
  word: string
  rule: TajweedRuleId
  /** Which kind of held sound fell short — they need different wording to the reciter. */
  kind: 'madd' | 'ghunnah'
  durationMs: number
  expectedMinMs: number
  /** 'severe': the word took no longer than it would have with no elongation at all, so
   * the madd looks absent. 'mild': elongated, but short of what the rule asks for. */
  severity: 'mild' | 'severe'
}

/** The rule this word is judged on: a madd if it carries one, otherwise a ghunnah. A word
 * with both is judged on its madd, which is the longer and more audible obligation. */
function heldRuleOf(rules: TajweedRuleId[]): { rule: TajweedRuleId; kind: 'madd' | 'ghunnah' } | null {
  const madd = rules.find((r) => MADD_RULES.has(r))
  if (madd) return { rule: madd, kind: 'madd' }
  const ghunnah = rules.find((r) => GHUNNA_RULES.has(r))
  return ghunnah ? { rule: ghunnah, kind: 'ghunnah' } : null
}

/**
 * How much of a word's held obligation was actually performed, at this reciter's pace.
 * Returns null when the hold was long enough to pass, or when the rule demands no extra
 * time at all.
 */
function judgeHold(
  refWord: WordWithRules,
  kind: 'madd' | 'ghunnah',
  measuredMs: number,
  tempoScale: number,
): { severity: 'mild' | 'severe'; minimumMs: number } | null {
  const expected = expectedDurationBreakdown(refWord)
  const unheld = (kind === 'madd' ? expected.withoutMadd : expected.withoutGhunnah) * tempoScale
  const obligation = expected.total * tempoScale - unheld
  if (obligation <= 0) return null

  const performed = (measuredMs - unheld) / obligation

  // The pace-independent check. Asking only whether a word is short *relative to the rest*
  // cannot see a passage whose obligations are all skipped alike — everything is equally
  // short, so nothing is an outlier. This asks instead whether the word had room for its
  // hold at all, at the fastest anyone plausibly recites.
  //
  // No further leniency is applied on top: those floors already assume the quickest
  // syllables and the shortest holds anyone performs, so discounting them again (as a first
  // version did, by reusing the 40% allowance below) would let a word through that could
  // not physically have contained its hold. Only measurement error is allowed for.
  const fastest = fastestPlausibleDuration(refWord, kind)
  const floorMs = fastest.baseMs + fastest.holdMs
  const impossible = fastest.holdMs > 0 && measuredMs < floorMs - TIMING_TOLERANCE_MS

  if (performed >= HOLD_FULFILLED_ENOUGH && !impossible) return null

  const shortfall = impossible
    ? Math.min(performed, (measuredMs - fastest.baseMs) / Math.max(1, fastest.holdMs))
    : performed
  return {
    severity: shortfall <= HOLD_ABSENT_BELOW ? 'severe' : 'mild',
    minimumMs: Math.max(unheld + obligation * HOLD_FULFILLED_ENOUGH, floorMs - TIMING_TOLERANCE_MS),
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * The reciter's pace for judging one word, taken from *the other* words of the passage.
 *
 * Leaving the word out matters. Including it drags the yardstick toward the very thing
 * being measured, and on a short passage it dominates: with two words, a median that
 * includes the rushed one lands halfway to it and the fault half disappears. Excluding it
 * asks the only question worth asking — was this word short *compared with how this reciter
 * read everything else*.
 *
 * This replaces a blunt `ratios.length < 3` guard that simply returned no alerts at all on
 * short passages. «عَمَّ يَتَسَآءَلُونَ» is two words, so an ayah of Sūrat al-Nabaʾ recited with
 * the ghunnah deliberately dropped raised nothing whatever — the check had not disagreed,
 * it had never run.
 */
function paceExcluding(ratios: number[], index: number): number | null {
  const others = ratios.filter((_, i) => i !== index)
  if (others.length === 0) return null
  return clamp(median(others), 0.4, 2.5)
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
  const ratioIndex = new Map<number, number>()
  referenceWords.forEach((refWord, i) => {
    const timing = wordTimings[i]
    if (!timing) return
    const measuredMs = (timing[1] - timing[0]) * 1000
    if (measuredMs <= 0) return
    const expected = expectedDurationBreakdown(refWord)
    if (expected.total > 0) {
      ratioIndex.set(i, ratios.length)
      ratios.push(measuredMs / expected.total)
    }
  })

  const alerts: AcousticAlert[] = []
  referenceWords.forEach((refWord, i) => {
    if (!correctRefIndices.has(i)) return
    const timing = wordTimings[i]
    if (!timing) return
    const held = heldRuleOf(refWord.rules)
    if (!held) return

    const measuredMs = (timing[1] - timing[0]) * 1000
    if (measuredMs <= 0) return

    const slot = ratioIndex.get(i)
    const tempoScale = slot === undefined ? null : paceExcluding(ratios, slot)
    if (tempoScale === null) return

    const judged = judgeHold(refWord, held.kind, measuredMs, tempoScale)
    if (!judged) return

    alerts.push({
      refIndex: i,
      word: refWord.word,
      rule: held.rule,
      kind: held.kind,
      durationMs: measuredMs,
      expectedMinMs: judged.minimumMs,
      severity: judged.severity,
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
  const ratioIndex = new Map<number, number>()
  for (const w of aligned) {
    if (w.refIndex === null) continue
    const refWord = referenceWords[w.refIndex]
    if (!refWord) continue
    const measuredMs = measuredMsOf(w)
    if (measuredMs === null) continue
    const expected = expectedDurationBreakdown(refWord)
    if (expected.total > 0) {
      ratioIndex.set(w.refIndex, ratios.length)
      ratios.push(measuredMs / expected.total)
    }
  }

  const alerts: AcousticAlert[] = []
  for (const w of aligned) {
    if (w.refIndex === null || w.hypIndex === null) continue
    if (!correctRefIndices.has(w.refIndex)) continue
    const refWord = referenceWords[w.refIndex]
    const held = refWord ? heldRuleOf(refWord.rules) : null
    if (!held) continue

    const measuredMs = measuredMsOf(w)
    if (measuredMs === null) continue

    const slot = ratioIndex.get(w.refIndex)
    const tempoScale = slot === undefined ? null : paceExcluding(ratios, slot)
    if (tempoScale === null) continue

    const judged = judgeHold(refWord, held.kind, measuredMs, tempoScale)
    if (!judged) continue

    alerts.push({
      refIndex: w.refIndex,
      word: refWord.word,
      rule: held.rule,
      kind: held.kind,
      durationMs: measuredMs,
      expectedMinMs: judged.minimumMs,
      severity: judged.severity,
    })
  }
  return alerts
}
