import type { WordWithRules } from './tajweed'
import type { TajweedRuleId } from '../types/quran'
import type { AlignedWord } from './alignment'
import type { TimedChunk } from '../asr/whisper.worker'
import { expectedDurationBreakdown, fastestPlausibleDuration, measuredHarakaMs } from './wordTiming'
import { detectPace, paceOf, type PaceId, type PaceProfile } from './recitationPace'
import { referenceExpectations, type ReferenceExpectation, type ReferenceTiming } from './referenceTiming'
import { heldRulesOf } from './ruleMeter'
import type { DetectorCheck, UndecidedReason } from './findings'

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

/** The smallest obligation, in ḥarakāt above the syllable baseline, that a whole word's duration
 * can actually resolve. See the note where it is used. */
const MIN_DECISIVE_HARAKAT = 2

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
  /** How many rulings of this word the one measurement covered. Above one, the shortfall is
   * the group's: a whole-word duration cannot say which of two madds was cut. */
  covers?: number
}

/** The rule this word is judged on: a madd if it carries one, otherwise a ghunnah. A word
 * with both is judged on its madd, which is the longer and more audible obligation.
 * Exported so the live tracker can name the same rule while the reciter is still reading. */
export function heldRuleOf(rules: TajweedRuleId[]): { rule: TajweedRuleId; kind: 'madd' | 'ghunnah' } | null {
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
  paceId: PaceId | undefined,
  /** What an accredited reciter actually gave this word, already in the learner's tempo.
   * When present it replaces the theoretical duration below: a real performance of the
   * ruling is better evidence than any constant reasoned from the books. */
  reference: ReferenceExpectation | null,
  /**
   * True when the passage offered no other word to establish this reciter's pace, so the
   * only trustworthy evidence is the physical floor — which is pace-independent by
   * construction and therefore cannot produce a false accusation.
   */
  floorsOnly = false,
): { severity: 'mild' | 'severe'; minimumMs: number } | null {
  const theory = expectedDurationBreakdown(refWord, paceId)
  const expected = reference
    ? { total: reference.totalMs, withoutMadd: reference.withoutMaddMs, withoutGhunnah: reference.withoutGhunnahMs }
    : { total: theory.total * tempoScale, withoutMadd: theory.withoutMadd * tempoScale, withoutGhunnah: theory.withoutGhunnah * tempoScale }
  const unheld = kind === 'madd' ? expected.withoutMadd : expected.withoutGhunnah
  const obligation = expected.total - unheld
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
  const fastest = fastestPlausibleDuration(refWord, kind, paceId)
  const floorMs = fastest.baseMs + fastest.holdMs
  const impossible = fastest.holdMs > 0 && measuredMs < floorMs - TIMING_TOLERANCE_MS

  // With no pace evidence, `performed` is measured against a tempo nobody confirmed, so it
  // is not allowed to accuse on its own — only the floor may.
  if (floorsOnly) {
    if (!impossible) return null
  } else if (performed >= HOLD_FULFILLED_ENOUGH && !impossible) {
    return null
  }

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
 * The held rulings of a word, as separate obligations where the markup says so.
 *
 * Falls back to the rule list when the word carries no letter-level spans (hand-built words
 * and fixtures), which is the forgiving reading: one obligation instead of several.
 */
function heldMarkingsOf(word: WordWithRules, paceId?: PaceId): { rule: TajweedRuleId; kind: 'madd' | 'ghunnah' }[] {
  const marks = heldRulesOf(word, paceId).map((m) => ({ rule: m.rule, kind: m.kind }))
  if (marks.length > 0) return marks
  const single = heldRuleOf(word.rules)
  return single ? [single] : []
}

/**
 * Everything the duration check looked at in one word, whatever it found.
 *
 * Reporting only faults made a ruling nobody could measure indistinguishable from one
 * performed correctly — see findings.ts. Each case that used to be a silent `return` now
 * names itself instead: the word was never confirmed, no timing came back, the passage gave
 * no pace to compare against, or the word holds two rulings its total duration cannot tell
 * apart.
 */
function auditWord(
  refWord: WordWithRules,
  refIndex: number,
  measuredMs: number | null,
  confirmed: boolean,
  tempoScale: number | null,
  paceId: PaceId | undefined,
  reference: ReferenceExpectation | null,
): DetectorCheck[] {
  const marks = heldMarkingsOf(refWord, paceId)
  if (marks.length === 0) return []

  const maddRules = marks.filter((m) => m.kind === 'madd').map((m) => m.rule)
  const ghunnahRules = marks.filter((m) => m.kind === 'ghunnah').map((m) => m.rule)
  // A word's own duration is one number, so it can settle one held obligation. Where a word
  // carries both, the madd is the longer and more audible of the two and is the one judged;
  // the ghunnah is left to the nasality check, which measures it directly.
  const judgedKind: 'madd' | 'ghunnah' = maddRules.length > 0 ? 'madd' : 'ghunnah'
  const judgedRules = judgedKind === 'madd' ? maddRules : ghunnahRules
  const deferred = judgedKind === 'madd' ? ghunnahRules : []

  const checks: DetectorCheck[] = []
  const undecided = (rules: TajweedRuleId[], reason: UndecidedReason): DetectorCheck | null =>
    rules.length === 0
      ? null
      : { refIndex, rules, evidence: 'duration', outcome: 'undecided', reason, measuredMs, minimumMs: null }

  if (deferred.length > 0) checks.push(undecided(deferred, 'not-isolated')!)

  if (!confirmed) {
    checks.push(undecided(judgedRules, 'word-not-confirmed')!)
    return checks
  }
  if (measuredMs === null || measuredMs <= 0) {
    checks.push(undecided(judgedRules, 'no-timing')!)
    return checks
  }

  // An obligation smaller than the noise in a word boundary cannot be judged by the word's
  // duration, and pretending otherwise is where most of the false alarms came from.
  //
  // Measured, again on ~6,400 words of nine published Ḥafṣ recitations: the two-ḥaraka madds —
  // ṭabīʿī, ʿiwaḍ, badal, ṣilah ṣughrā — add a median of one ḥaraka above the syllable baseline
  // and a *tenth percentile of about zero*. Half of all correct performances therefore sit below
  // any threshold strict enough to catch a dropped one; «مِهَـٰدًا» and «شِدَادًا» were reported
  // short for reciter after reciter. A madd ṭabīʿī is roughly one extra vowel beat, 200–400ms,
  // which is the same order as the error in knowing where a word begins and ends.
  //
  // So duration judges only what it can resolve: obligations of two ḥarakāt or more above the
  // baseline, which is the muttaṣil, the munfaṣil, the lāzim and an ʿāriḍ someone chose to
  // stretch. Everything shorter is reported as unverified, which is what it is.
  const pace = paceOf(paceId)
  const theory = expectedDurationBreakdown(refWord, paceId)
  const obligationHarakat = (theory.total - theory.withoutMadd) / pace.harakaMs
  if (judgedKind === 'madd' && obligationHarakat < MIN_DECISIVE_HARAKAT) {
    checks.push(undecided(judgedRules, 'duration-not-decisive')!)
    return checks
  }

  /**
   * With several obligations sharing one measurement, only a gross deficit can be reported.
   *
   * «كِتَـٰبًا» stopped on carries a madd on its alif and a madd ʿiwaḍ on its tanwīn: two holds,
   * one duration. A word a little shorter than the sum of them says nothing about either — and
   * that is where most of the remaining false alarms sat, «مِهَـٰدًا», «أَزْوَٲجًا», «جَزَآءً»
   * reported short for reciter after reciter.
   *
   * So a shared measurement may still say "one or both of these holds is missing" — a deficit
   * that large is not attributable but it is real, and it is what «الٓمٓ» read flat looks like —
   * while a marginal shortfall is left undecided, because nothing here can say which ruling it
   * belongs to or whether it exists at all.
   */
  const shared = judgedRules.length > 1
  const floorsOnly = tempoScale === null
  const byTheory = judgeHold(refWord, judgedKind, measuredMs, tempoScale ?? 1, paceId, null, floorsOnly)
  // An accredited reciter's own performance of this ruling is evidence, but it is one
  // reciter's performance: tempo and melody differ legitimately between readings, and a
  // single recording is not entitled to convict on its own. So the reference may corroborate
  // a fault and may exonerate — it may not be the only voice calling something wrong.
  const byReference = reference
    ? judgeHold(refWord, judgedKind, measuredMs, tempoScale ?? 1, paceId, reference, floorsOnly)
    : null
  const disagree = reference !== null && (byTheory === null) !== (byReference === null)

  if (disagree) {
    checks.push(undecided(judgedRules, 'reference-disagrees')!)
    return checks
  }

  const judged = byTheory && byReference ? (byTheory.minimumMs <= byReference.minimumMs ? byTheory : byReference) : byTheory
  if (!judged) {
    // Nothing found wrong. With a pace to compare against that is a measurement; without
    // one, all that was checked is that the hold could physically have fitted, which rules
    // out a gross omission and confirms nothing else.
    checks.push({
      refIndex,
      rules: judgedRules,
      evidence: 'duration',
      kind: judgedKind,
      outcome: floorsOnly ? 'undecided' : 'met',
      reason: floorsOnly ? 'no-pace' : undefined,
      measuredMs,
      minimumMs: null,
    })
    return checks
  }

  // A ghunnah's *length* is not evidence enough to convict.
  //
  // This file has always said the nasality check is the only thing that can settle a ghunnah on
  // a short word (see the note at the top of nasality.ts); the measurements now say how weak
  // the clock is. Across ~6,400 words of nine published Ḥafṣ recitations, the time a ghunnah
  // adds above the syllable baseline has a median near 1.4 ḥarakāt against the two the books
  // ask, and a tenth percentile near zero — a correct ghunnah routinely looks, to a clock, like
  // no ghunnah at all. Faulting on that produced false alarms on «عَمَّ» and «ٱلنَّبَإِ» for
  // reciter after reciter. So the duration check now declines, and nasality decides: it either
  // reports the fault itself or leaves the ruling undecided, which is the honest outcome when
  // the only usable signal is missing.
  if (judgedKind === 'ghunnah') {
    checks.push(undecided(judgedRules, 'duration-not-decisive')!)
    return checks
  }

  const severity = byTheory && byReference && (byTheory.severity === 'mild' || byReference.severity === 'mild')
    ? 'mild'
    : judged.severity

  // A shortfall too small to be a missing hold, on a word whose rulings share one measurement.
  if (shared && severity === 'mild') {
    checks.push(undecided(judgedRules, 'not-isolated')!)
    return checks
  }
  checks.push({
    refIndex,
    rules: judgedRules,
    evidence: 'duration',
    kind: judgedKind,
    outcome: severity === 'severe' ? 'absent' : 'short',
    measuredMs,
    minimumMs: judged.minimumMs,
  })
  return checks
}

/** The faults inside an audit, in the shape the results card has always consumed. */
export function faultsFrom(checks: DetectorCheck[], referenceWords: WordWithRules[]): AcousticAlert[] {
  const alerts: AcousticAlert[] = []
  for (const c of checks) {
    if (c.evidence !== 'duration' || !c.kind) continue
    if (c.outcome !== 'short' && c.outcome !== 'absent') continue
    alerts.push({
      refIndex: c.refIndex,
      word: referenceWords[c.refIndex]?.word ?? '',
      rule: c.rules[0],
      kind: c.kind,
      durationMs: Math.round(c.measuredMs ?? 0),
      expectedMinMs: c.minimumMs ?? 0,
      severity: c.outcome === 'absent' ? 'severe' : 'mild',
      /** More than one ruling shared the measurement, so the shortfall belongs to the group. */
      covers: c.rules.length,
    })
  }
  return alerts
}

/**
 * Primary path: uses precise per-reference-word timing from forced alignment (cross-
 * attention + DTW against the *known* text — see scoreAndAlignReferenceWords in
 * whisper.worker.ts). The measured span is the madd word's own forced time range, not
 * whatever word a free decode happened to guess in its place.
 */
export function auditHeldRulesForced(
  referenceWords: WordWithRules[],
  wordTimings: ([number, number] | null)[],
  correctRefIndices: Set<number>,
  paceId?: PaceId,
  /** An accredited reciter's own timings for this same passage, when one has been aligned. */
  reference?: ReferenceTiming | null,
): DetectorCheck[] {
  const referenced = reference
    ? referenceExpectations(referenceWords, wordTimings, reference, paceId)
    : null
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
    const expected = expectedDurationBreakdown(refWord, paceId)
    if (expected.total > 0) {
      ratioIndex.set(i, ratios.length)
      ratios.push(measuredMs / expected.total)
    }
  })

  const checks: DetectorCheck[] = []
  referenceWords.forEach((refWord, i) => {
    const timing = wordTimings[i]
    const measuredMs = timing ? (timing[1] - timing[0]) * 1000 : null
    const slot = ratioIndex.get(i)
    // A passage of one word has no *other* word to set the pace — and returning nothing
    // there meant the check simply did not run. Reciting «الٓمٓ» on its own with no madd at
    // all was reported as a flawless 100%, though six ḥarakāt of madd lāzim were owed and
    // roughly none were given. The physical floors were built for exactly this: they ask
    // whether the hold could have fitted at all, at the fastest anyone recites, and need no
    // pace to do it.
    const tempoScale = slot === undefined ? null : paceExcluding(ratios, slot)
    checks.push(
      ...auditWord(refWord, i, measuredMs, correctRefIndices.has(i), tempoScale, paceId, referenced?.[i] ?? null),
    )
  })
  return checks
}

export function detectMaddDurationAlertsForced(
  referenceWords: WordWithRules[],
  wordTimings: ([number, number] | null)[],
  correctRefIndices: Set<number>,
  paceId?: PaceId,
  reference?: ReferenceTiming | null,
): AcousticAlert[] {
  return faultsFrom(
    auditHeldRulesForced(referenceWords, wordTimings, correctRefIndices, paceId, reference),
    referenceWords,
  )
}

/**
 * Fallback path for when forced-alignment timing isn't available this time: approximates
 * each word's duration from the free decode's own (unforced) word timestamps via the
 * free-decode alignment. Less precise — the "word" boundaries come from whatever the free
 * decode guessed, which may not exactly match the reference word's real span.
 */
export function auditHeldRulesFromFreeDecode(
  aligned: AlignedWord[],
  referenceWords: WordWithRules[],
  chunks: TimedChunk[],
  correctRefIndices: Set<number>,
  paceId?: PaceId,
): DetectorCheck[] {
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
  const measured = new Map<number, number>()
  for (const w of aligned) {
    if (w.refIndex === null) continue
    const refWord = referenceWords[w.refIndex]
    if (!refWord) continue
    const measuredMs = measuredMsOf(w)
    if (measuredMs === null) continue
    measured.set(w.refIndex, measuredMs)
    const expected = expectedDurationBreakdown(refWord, paceId)
    if (expected.total > 0) {
      ratioIndex.set(w.refIndex, ratios.length)
      ratios.push(measuredMs / expected.total)
    }
  }

  const checks: DetectorCheck[] = []
  referenceWords.forEach((refWord, i) => {
    const slot = ratioIndex.get(i)
    // Same reasoning as the forced path: with no other word to set the pace, the physical
    // floors are the only evidence — and they need none. Both a `chunks.length < 3` guard
    // and an early return here used to make this whole check silently do nothing on a short
    // passage, which is how «الٓمٓ» recited with no madd at all came back a flawless 100%:
    // its forced timings were unavailable, so the fallback ran, and the fallback refused.
    const tempoScale = slot === undefined ? null : paceExcluding(ratios, slot)
    checks.push(
      ...auditWord(refWord, i, measured.get(i) ?? null, correctRefIndices.has(i), tempoScale, paceId, null),
    )
  })
  return checks
}

export function detectMaddDurationAlertsFromFreeDecode(
  aligned: AlignedWord[],
  referenceWords: WordWithRules[],
  chunks: TimedChunk[],
  correctRefIndices: Set<number>,
  paceId?: PaceId,
): AcousticAlert[] {
  if (chunks.length === 0) return []
  return faultsFrom(
    auditHeldRulesFromFreeDecode(aligned, referenceWords, chunks, correctRefIndices, paceId),
    referenceWords,
  )
}

/**
 * Which pace the reciter was *actually* reading in, whatever they selected.
 *
 * The selected pace decides what is owed; this reports what was delivered, so the app can
 * say "you read this in tadwīr" rather than silently grading a ḥadr recitation against
 * taḥqīq's madds. Words carrying a held rule are left out of the estimate: their duration is
 * dominated by the hold under examination, and letting the thing being judged set the
 * yardstick is the mistake that made a fully-recited madd look short.
 */
export function detectRecitedPace(
  referenceWords: WordWithRules[],
  wordTimings: ([number, number] | null)[],
  correctRefIndices: Set<number>,
  selectedPaceId?: PaceId,
): { pace: PaceProfile; harakaMs: number; matchesSelected: boolean } | null {
  const estimates: number[] = []
  referenceWords.forEach((refWord, i) => {
    if (!correctRefIndices.has(i)) return
    if (heldRuleOf(refWord.rules)) return
    const timing = wordTimings[i]
    if (!timing) return
    const ms = (timing[1] - timing[0]) * 1000
    const haraka = measuredHarakaMs(refWord, ms, selectedPaceId)
    if (haraka !== null && haraka > 0) estimates.push(haraka)
  })
  if (estimates.length === 0) return null

  const harakaMs = median(estimates)
  const pace = detectPace(harakaMs)
  return { pace, harakaMs, matchesSelected: pace.id === paceOf(selectedPaceId).id }
}
