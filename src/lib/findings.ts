import type { TajweedRuleId } from '../types/quran'
import type { WordWithRules } from './tajweed'
import type { WordVerdict } from './verdicts'

/**
 * What the app actually verified, ruling by ruling — and what it could not.
 *
 * The app used to end in one percentage. That number could only ever mean "words Whisper
 * agreed with", yet placed alone at the top of a screen about tajweed it was read as a mark
 * out of a hundred for the recitation as a whole, which nothing here measures. Worse, a
 * ruling that no check could reach was indistinguishable from one performed correctly: both
 * simply produced no alert, so silence meant "good" and "no idea" at once.
 *
 * So every ruling in the recited span now ends in one of four states, and the reason is part
 * of the result:
 *
 *   met        — a measurement was made and the ruling was satisfied;
 *   short      — measured, and less than the ruling asks for;
 *   absent     — measured, and the obligation appears not to have been performed at all;
 *   undecided  — no honest measurement was possible, and here is why.
 *
 * `undecided` is the state this file exists for. A learner told "I could not verify the
 * ikhfāʾ here — the recording was too quiet" has been treated as an adult; one shown a green
 * tick over the same audio has been misled. It is also the only way to stop the app
 * correcting a correct recitation, which is the failure a learner forgives least.
 *
 * Nothing here is averaged into a score. Rulings are counted, and the three counts are shown
 * side by side: an average would have to decide how much an undecided ruling is worth, and
 * there is no answer to that question.
 */

/** The kind of acoustic evidence a ruling can be settled by, in this build. */
export type EvidenceKind =
  /** How long the word took, against how long its obligation needs. */
  | 'duration'
  /** How nasal the word sounded, against this reciter's own non-nasal words. */
  | 'nasality'
  /** A closure followed by a release burst inside the word's span. */
  | 'burst'
  /** The sustained sound itself, measured inside the word — the ruling's own performance
   * rather than the length of the word around it. See holdAudit.ts. */
  | 'hold'

export type FindingOutcome = 'met' | 'short' | 'absent' | 'undecided'

export type UndecidedReason =
  /** No detector in this build measures this kind of ruling at all. */
  | 'not-measurable'
  /** The word itself was not confirmed as recited, so nothing inside it can be judged. */
  | 'word-not-confirmed'
  /** No time span for this word came back from the alignment. */
  | 'no-timing'
  /** Nothing in the passage established the reciter's pace, so only the physical floor could
   * be applied — it was cleared, which rules out a gross omission but confirms nothing. */
  | 'no-pace'
  /** More than one held ruling shares this word, and a whole-word duration cannot say which
   * of them was short. */
  | 'not-isolated'
  /** The theoretical measure and the reference reciter's own performance disagreed about
   * whether this was a fault, so neither is allowed to convict. */
  | 'reference-disagrees'
  /** The signal was too brief, too quiet or too noisy for this check to mean anything. */
  | 'weak-signal'
  /** The recording as a whole could not be matched to the selected passage. */
  | 'passage-mismatch'
  /** The reciter's own comparison words were missing, so a relative measure had no baseline. */
  | 'no-baseline'
  /** Duration is too weak a signal for this ruling to be judged by it — measured, not assumed:
   * see the note in acousticTajweed.ts. Another check decides, or nobody does. */
  | 'duration-not-decisive'

export const UNDECIDED_REASON_AR: Record<UndecidedReason, string> = {
  'not-measurable': 'لا يوجد في هذه النسخة قياس صوتي لهذا النوع من الأحكام',
  'word-not-confirmed': 'لم نتأكّد أنّ الكلمة نفسها قُرئت، فلا يصحّ الحكم على حكمها',
  'no-timing': 'لم نحصل على زمن دقيق لهذه الكلمة',
  'no-pace': 'لم يكفِ المقطع لتقدير سرعتك، فلم نتحقّق إلا من أنّ الحكم لم يُهمل تمامًا',
  'not-isolated': 'في الكلمة أكثر من حكم مدّي، وزمن الكلمة كاملةً لا يفصل بينها',
  'reference-disagrees': 'اختلف المقدار النظري عن أداء القارئ المرجعي، فلم نُثبت خطأً بأحدهما',
  'weak-signal': 'الإشارة الصوتية أضعف أو أقصر من أن تُبنى عليها نتيجة',
  'passage-mismatch': 'لم نتعرّف على المقطع في التسجيل',
  'no-baseline': 'لم تتوفّر في تسجيلك كلمات مقارنة تكفي لهذا القياس',
  'duration-not-decisive': 'زمن الكلمة لا يكفي للحكم على هذا النوع، والحكم فيه على رنين الخيشوم',
}

/**
 * Which evidence this build can bring to bear on a ruling.
 *
 * The empty list is the important entry. Iẓhār, the idghāms without ghunnah, tafkhīm and
 * tarqīq, the makhārij — a good half of what a tajweed teacher listens for — have no detector
 * here, because deciding them needs to know which *letter* produced which stretch of sound,
 * and the alignment in this app resolves words. Saying so is the difference between a
 * verified reading and an unexamined one.
 */
export function evidenceForRule(rule: TajweedRuleId): EvidenceKind[] {
  switch (rule) {
    // Held elongations: duration is exactly what the ruling is about.
    case 'madda_normal':
    case 'madda_permissible':
    case 'madda_obligatory':
    case 'madda_necessary':
    case 'madda_badal':
    case 'madda_sila_sughra':
    case 'madda_sila_kubra':
    case 'madda_leen':
    case 'madda_arid':
    case 'madda_iwad':
      return ['hold', 'duration']
    // A held nasal sound: both how long it lasted and whether it was nasal at all.
    case 'ghunnah':
    case 'ikhafa':
    case 'ikhafa_shafawi':
    case 'idgham_ghunnah':
    case 'iqlab':
      return ['hold', 'duration', 'nasality']
    case 'qalqalah':
      return ['burst']
    default:
      return []
  }
}

/** One measurement's verdict on one or more rulings of a single word. Produced by the
 * detectors, which each report everything they looked at — not only what failed. */
export interface DetectorCheck {
  refIndex: number
  /** The markings this one measurement covers. More than one means the measurement could not
   * separate them: the outcome then belongs to them jointly, which the report says out loud
   * rather than pinning a shortfall on whichever ruling came first. */
  rules: TajweedRuleId[]
  evidence: EvidenceKind
  /** Which sort of held sound was measured, where that distinction exists. */
  kind?: 'madd' | 'ghunnah'
  outcome: FindingOutcome
  reason?: UndecidedReason
  measuredMs?: number | null
  minimumMs?: number | null
}

/** One ruling of one word, and what became of it. */
export interface RuleFinding {
  refIndex: number
  word: string
  rule: TajweedRuleId
  /** Where in the word this ruling's letters sit, when the markup says. */
  start?: number
  end?: number
  outcome: FindingOutcome
  reason?: UndecidedReason
  /** What settled it, or what would have been needed. */
  evidence: EvidenceKind[]
  measuredMs?: number | null
  minimumMs?: number | null
  /** How many rulings the deciding measurement covered at once. Above one, the outcome is
   * the group's, not this ruling's alone. */
  covers?: number
}

export interface TajweedReport {
  findings: RuleFinding[]
  met: RuleFinding[]
  faulted: RuleFinding[]
  undecided: RuleFinding[]
}

const SEVERITY: Record<FindingOutcome, number> = { absent: 3, short: 2, met: 1, undecided: 0 }

/** The markings of a word, preferring the letter-level spans the markup gives. */
function markingsOf(word: WordWithRules): { rule: TajweedRuleId; start?: number; end?: number }[] {
  const spans = word.spans ?? []
  if (spans.length > 0) {
    const covered = new Set(spans.map((s) => s.rule))
    const extra = word.rules.filter((r) => !covered.has(r)).map((rule) => ({ rule }))
    return [...spans.map((s) => ({ rule: s.rule, start: s.start, end: s.end })), ...extra]
  }
  return word.rules.map((rule) => ({ rule }))
}

export interface ReportInput {
  referenceWords: WordWithRules[]
  verdicts: WordVerdict[]
  /** Everything the detectors examined, whatever the outcome. */
  checks: DetectorCheck[]
  /** False when the transcription could not be matched to the selected passage — then
   * nothing in it is evidence about anything. */
  passageRecognized: boolean
  /** False when the recording was too quiet to measure. */
  audioUsable: boolean
}

/**
 * Every ruling in the recited span, each with what became of it.
 *
 * Words the reciter never reached are left out entirely: a ruling in an ayah that was not
 * read is not undecided, it is simply not yet attempted, and listing it would bury the
 * rulings that were.
 */
export function buildTajweedReport({
  referenceWords,
  verdicts,
  checks,
  passageRecognized,
  audioUsable,
}: ReportInput): TajweedReport {
  const byWord = new Map<number, DetectorCheck[]>()
  for (const check of checks) {
    const list = byWord.get(check.refIndex)
    if (list) list.push(check)
    else byWord.set(check.refIndex, [check])
  }

  const findings: RuleFinding[] = []
  referenceWords.forEach((word, refIndex) => {
    if (verdicts[refIndex]?.status === 'unreached') return
    const wordChecks = byWord.get(refIndex) ?? []

    for (const marking of markingsOf(word)) {
      const evidence = evidenceForRule(marking.rule)
      const base = { refIndex, word: word.word, rule: marking.rule, start: marking.start, end: marking.end, evidence }

      if (evidence.length === 0) {
        findings.push({ ...base, outcome: 'undecided', reason: 'not-measurable' })
        continue
      }
      // A recording that cannot be matched to the passage, or that is too quiet to measure,
      // invalidates every acoustic claim about it at once — including the favourable ones.
      if (!passageRecognized) {
        findings.push({ ...base, outcome: 'undecided', reason: 'passage-mismatch' })
        continue
      }
      if (!audioUsable) {
        findings.push({ ...base, outcome: 'undecided', reason: 'weak-signal' })
        continue
      }

      const relevant = wordChecks.filter((c) => c.rules.includes(marking.rule))
      if (relevant.length === 0) {
        findings.push({ ...base, outcome: 'undecided', reason: 'no-timing' })
        continue
      }
      /*
       * Where the ruling's own sound was measured, that measurement decides.
       *
       * The instruments are not equals. A hold check listened to the sustained sound this
       * ruling is made of; a duration check inferred it from how long the whole word took,
       * which on a two-ḥaraka madd is barely evidence at all. Letting the gravest verdict win
       * regardless would let the weaker instrument overrule the stronger one — and, worse,
       * would let a word that is merely short convict a madd the recording plainly contains.
       */
      const direct = relevant.filter((c) => c.evidence === 'hold' && c.outcome !== 'undecided')
      const pool = direct.length > 0 ? direct : relevant
      // Within one instrument, the gravest thing found decides, and a measurement that found
      // nothing wrong outranks one that could not look.
      const decisive = pool.reduce((worst, c) => (SEVERITY[c.outcome] > SEVERITY[worst.outcome] ? c : worst))
      findings.push({
        ...base,
        outcome: decisive.outcome,
        reason: decisive.reason,
        measuredMs: decisive.measuredMs ?? null,
        minimumMs: decisive.minimumMs ?? null,
        covers: decisive.rules.length,
      })
    }
  })

  return {
    findings,
    met: findings.filter((f) => f.outcome === 'met'),
    faulted: findings.filter((f) => f.outcome === 'short' || f.outcome === 'absent'),
    undecided: findings.filter((f) => f.outcome === 'undecided'),
  }
}

/** The words carrying at least one ruling nobody could verify — used to mark them in the
 * passage instead of painting them plainly correct. */
export function undecidedWordIndices(report: TajweedReport): Set<number> {
  const faulted = new Set(report.faulted.map((f) => f.refIndex))
  return new Set(report.undecided.map((f) => f.refIndex).filter((i) => !faulted.has(i)))
}
