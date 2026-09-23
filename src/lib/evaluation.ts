import type { TajweedRuleId } from '../types/quran'
import { applyDerivedRuleSpans, parseTajweedMarkup, segmentsToWords, type WordWithRules } from './tajweed'
import { analyzeRecitation, type AnalysisResult } from './analysis'
import { readBundleAudio, type AttemptBundle, type LabelVerdict } from './attemptBundle'
import type { AyahRange } from './verdicts'
import type { FindingOutcome } from './findings'

/**
 * What the detectors get right and wrong, rule by rule, against a teacher's ear.
 *
 * Every threshold in this app was reasoned from the books and from synthetic audio. That is
 * how they had to start — there is no corpus here — but it is not where they can honestly
 * stay, because a number that has never disagreed with a human being has never been tested.
 * This harness is the instrument for testing them: recordings whose faults are known, labelled
 * by somebody qualified to hear them, replayed through the same pipeline a reciter runs.
 *
 * Three things it deliberately does *not* do.
 *
 * It does not produce one accuracy number. A detector that is excellent on madd and useless
 * on qalqalah is two different facts, and averaging them hides the one you need to act on.
 *
 * It does not count an undecided ruling as either a pass or a failure. Refusing to judge is a
 * third outcome with its own cost — a detector that declines everything makes no mistakes and
 * is worthless — so the undecided rate is reported beside the errors, never folded into them.
 *
 * And it does not report a rate it cannot support. Two clips can produce a 100% false-alarm
 * rate, which looks like a catastrophe and means nothing. Counts are always shown; a rate
 * appears only once there are enough labels for it to survive one more clip.
 */

/** Below this many labelled instances of a rule, a rate is noise dressed as a measurement. */
export const MIN_LABELS_FOR_RATE = 10

export interface RuleStats {
  rule: TajweedRuleId
  /** Labels the teacher was sure about. 'unsure' is counted separately and judged by nobody. */
  labelled: number
  unsure: number
  /** The teacher said it was performed correctly. */
  labelledCorrect: number
  /** The teacher said it was short or absent. */
  labelledFaulty: number
  /** Teacher: correct. App: correct. */
  agreedCorrect: number
  /** Teacher: faulty. App: faulty. */
  agreedFaulty: number
  /** Teacher: correct. App: faulty. The worst error the app can make — it corrects a reciter
   * who was right, and that is what makes a learner stop trusting it. */
  falseAlarms: number
  /** Teacher: faulty. App: correct. The fault the app told the reciter they had not made. */
  misses: number
  /** The app declined to judge — split by what the truth turned out to be. */
  undecidedOnCorrect: number
  undecidedOnFaulty: number
  /** Null until there are enough labels to mean anything. */
  falseAlarmRate: number | null
  missRate: number | null
  /** How often the app managed to reach a verdict at all. */
  decidedRate: number | null
}

export interface EvaluationReport {
  clips: number
  labelledClips: number
  /** Clips that carried no labels: counted, and then ignored. */
  unlabelledClips: number
  /** Clips whose passage or audio could not be replayed, with the reason. */
  unusableClips: { id: string; reasonAr: string }[]
  byRule: RuleStats[]
  /** Labels naming a ruling that this build does not place on that word at all — a
   * disagreement about the *text*, not the performance, and a real finding: either the
   * labeller or the derivation engine is wrong about what the muṣḥaf says. */
  unmatchedLabels: { bundleId: string; refIndex: number; rule: TajweedRuleId }[]
  warningsAr: string[]
}

/** The words of a bundle's passage, exactly as the app built them. */
export function bundleWords(bundle: AttemptBundle): { words: WordWithRules[]; ayahRanges: AyahRange[] } {
  const words: WordWithRules[] = []
  const ayahRanges: AyahRange[] = []
  bundle.passage.ayahMarkup.forEach((markup, index) => {
    const start = words.length
    words.push(...segmentsToWords(applyDerivedRuleSpans(parseTajweedMarkup(markup))))
    ayahRanges.push({
      ayahNumber: bundle.passage.fromAyah + index,
      numberInSurah: bundle.passage.fromAyah + index,
      start,
      end: words.length,
    })
  })
  return { words, ayahRanges }
}

/** Replays one bundle through the same analysis the practice screen runs. */
export function replayBundle(bundle: AttemptBundle): { analysis: AnalysisResult; words: WordWithRules[] } {
  const { words, ayahRanges } = bundleWords(bundle)
  const { samples, sampleRate } = readBundleAudio(bundle.audio)
  const analysis = analyzeRecitation({
    referenceWords: words,
    ayahRanges,
    text: bundle.asr.text,
    chunks: bundle.asr.chunks ?? [],
    wordConfidences: bundle.asr.wordConfidences,
    wordTimings: bundle.asr.wordTimings.length > 0 ? bundle.asr.wordTimings : null,
    audio: samples,
    sampleRate,
    paceId: bundle.conditions.paceId,
    // No reference recitation: it is fetched from the network and differs by reciter, so
    // folding it in would make the harness non-deterministic for no gain.
    reference: null,
  })
  return { analysis, words }
}

function emptyStats(rule: TajweedRuleId): RuleStats {
  return {
    rule,
    labelled: 0,
    unsure: 0,
    labelledCorrect: 0,
    labelledFaulty: 0,
    agreedCorrect: 0,
    agreedFaulty: 0,
    falseAlarms: 0,
    misses: 0,
    undecidedOnCorrect: 0,
    undecidedOnFaulty: 0,
    falseAlarmRate: null,
    missRate: null,
    decidedRate: null,
  }
}

const rate = (numerator: number, denominator: number): number | null =>
  denominator >= MIN_LABELS_FOR_RATE ? numerator / denominator : null

export function evaluateBundles(bundles: AttemptBundle[]): EvaluationReport {
  const byRule = new Map<TajweedRuleId, RuleStats>()
  const unmatchedLabels: EvaluationReport['unmatchedLabels'] = []
  const unusableClips: EvaluationReport['unusableClips'] = []
  let labelledClips = 0
  let unlabelledClips = 0

  for (const bundle of bundles) {
    if (!bundle.labels || bundle.labels.rules.length === 0) {
      unlabelledClips++
      continue
    }
    let analysis: AnalysisResult
    let words: WordWithRules[]
    try {
      ;({ analysis, words } = replayBundle(bundle))
    } catch (err) {
      unusableClips.push({ id: bundle.id, reasonAr: `تعذّر إعادة التشغيل: ${(err as Error).message}` })
      continue
    }
    labelledClips++

    // What the app concluded about each ruling of each word, keyed the way labels are.
    const outcomes = new Map<string, FindingOutcome>()
    for (const finding of analysis.report.findings) {
      const key = `${finding.refIndex}:${finding.rule}`
      // A word can carry the same ruling twice (the lām and the mīm of «الٓمٓ»). A label
      // cannot yet tell them apart, so the stricter of the two is taken: if either was
      // faulted, the app faulted this word's ruling.
      const previous = outcomes.get(key)
      if (previous === 'absent' || previous === 'short') continue
      outcomes.set(key, finding.outcome)
    }

    for (const label of bundle.labels.rules) {
      const word = words[label.refIndex]
      if (!word || !word.rules.includes(label.rule)) {
        unmatchedLabels.push({ bundleId: bundle.id, refIndex: label.refIndex, rule: label.rule })
        continue
      }
      let stats = byRule.get(label.rule)
      if (!stats) {
        stats = emptyStats(label.rule)
        byRule.set(label.rule, stats)
      }
      if (label.verdict === 'unsure') {
        stats.unsure++
        continue
      }
      stats.labelled++
      const truthIsFault: boolean = label.verdict !== ('correct' satisfies LabelVerdict)
      if (truthIsFault) stats.labelledFaulty++
      else stats.labelledCorrect++

      const outcome = outcomes.get(`${label.refIndex}:${label.rule}`) ?? 'undecided'
      if (outcome === 'undecided') {
        if (truthIsFault) stats.undecidedOnFaulty++
        else stats.undecidedOnCorrect++
        continue
      }
      const appSaysFault = outcome === 'short' || outcome === 'absent'
      if (truthIsFault && appSaysFault) stats.agreedFaulty++
      else if (!truthIsFault && !appSaysFault) stats.agreedCorrect++
      else if (appSaysFault) stats.falseAlarms++
      else stats.misses++
    }
  }

  const rules = [...byRule.values()].map((stats) => ({
    ...stats,
    falseAlarmRate: rate(stats.falseAlarms, stats.labelledCorrect),
    missRate: rate(stats.misses, stats.labelledFaulty),
    decidedRate: rate(stats.labelled - stats.undecidedOnCorrect - stats.undecidedOnFaulty, stats.labelled),
  }))
  rules.sort((a, b) => b.labelled - a.labelled)

  const warningsAr: string[] = []
  if (labelledClips === 0) {
    warningsAr.push('لا توجد تسجيلات موسومة: لم يُقَس شيء. هذه النتيجة ليست «ناجحة»، بل فارغة.')
  }
  const thin = rules.filter((r) => r.labelled < MIN_LABELS_FOR_RATE)
  if (thin.length > 0) {
    warningsAr.push(
      `أحكام لم تبلغ ${MIN_LABELS_FOR_RATE} وسومًا فلا نِسَب لها: ${thin.map((r) => r.rule).join('، ')}.`,
    )
  }
  if (unmatchedLabels.length > 0) {
    warningsAr.push(
      `${unmatchedLabels.length} وسمًا يشير إلى حكم لا يضعه التطبيق على تلك الكلمة — خلاف على النص نفسه، راجعه قبل أي استنتاج.`,
    )
  }
  const labellers = new Set(bundles.map((b) => b.labels?.labelledByAr).filter(Boolean))
  if (labellers.size === 1 && labelledClips > 0) {
    warningsAr.push('كل الوسوم من مُقيِّم واحد: لا يمكن تقدير اختلاف المقيّمين بينهم، فاعتبر النتائج مبدئية.')
  }
  const devices = new Set(bundles.map((b) => b.conditions.deviceAr ?? '').filter(Boolean))
  if (devices.size === 1 && labelledClips > 2) {
    warningsAr.push('كل التسجيلات من جهاز واحد: المستويات المطلقة تتغيّر بتغيّر الميكروفون، فلا تعمّم النتيجة عليه.')
  }

  return {
    clips: bundles.length,
    labelledClips,
    unlabelledClips,
    unusableClips,
    byRule: rules,
    unmatchedLabels,
    warningsAr,
  }
}

/** A plain-text table for a terminal — the harness's actual output. */
export function formatEvaluation(report: EvaluationReport): string {
  const lines: string[] = []
  lines.push(
    `clips: ${report.clips}  labelled: ${report.labelledClips}  unlabelled: ${report.unlabelledClips}  unusable: ${report.unusableClips.length}`,
  )
  lines.push('')
  lines.push('rule                     n   truth✓ truth✗  false-alarm      miss     undecided')
  lines.push('-'.repeat(80))
  for (const r of report.byRule) {
    const fa = r.falseAlarmRate === null ? `${r.falseAlarms}/${r.labelledCorrect} (n/a)` : `${(r.falseAlarmRate * 100).toFixed(0)}% (${r.falseAlarms}/${r.labelledCorrect})`
    const miss = r.missRate === null ? `${r.misses}/${r.labelledFaulty} (n/a)` : `${(r.missRate * 100).toFixed(0)}% (${r.misses}/${r.labelledFaulty})`
    const und = `${r.undecidedOnCorrect + r.undecidedOnFaulty}/${r.labelled}`
    lines.push(
      `${r.rule.padEnd(22)} ${String(r.labelled).padStart(3)}   ${String(r.labelledCorrect).padStart(5)} ${String(r.labelledFaulty).padStart(6)}  ${fa.padStart(15)} ${miss.padStart(14)} ${und.padStart(9)}`,
    )
  }
  if (report.warningsAr.length > 0) {
    lines.push('')
    for (const w of report.warningsAr) lines.push(`⚠︎ ${w}`)
  }
  return lines.join('\n')
}
