import type { WordWithRules } from './tajweed'
import type { PaceId } from './recitationPace'
import { FFT_SIZE, HoldTracker } from './holdDetector'
import { heldRulesOf, matchHoldsToRules, type RuleMeter } from './ruleMeter'
import type { DetectorCheck } from './findings'

/**
 * Measuring each ruling by the sound it is made of, instead of by how long its word took.
 *
 * A word's total duration is a poor instrument for a two-ḥaraka madd: calibration against nine
 * published Ḥafṣ recitations put what such a madd adds at a median of one ḥaraka with a tenth
 * percentile of about zero — the same order as the error in knowing where a word begins and
 * ends. The duration check therefore (rightly) declines them, and a short sūra came back with
 * every ruling «غير محسوم», which is honest and useless.
 *
 * The sound itself is a much better instrument, and the app already has the detector for it:
 * the live meter watches the spectrum settle and move again, so it hears *the hold* rather than
 * the word around it. It simply never ran on the recording. Running it there gives what the
 * clock could not: a measurement per marking rather than per word, so «الٓمٓ» is two answers and
 * not one, and a madd of two ḥarakāt is resolvable because two ḥarakāt of sustained sound are
 * hundreds of milliseconds of evidence, whatever the word's boundaries happen to be.
 */

/** The share of a ruling's due below which the hold is treated as never performed. */
const HOLD_ABSENT_BELOW = 0.25
/** Frames the tracker is fed, matching what the live path hands it. */
const HOP_MS = 20

export interface HoldAudit {
  checks: DetectorCheck[]
  /** The filled meters, so the results can show the same bars the live view shows. */
  metersByWord: Map<number, RuleMeter[]>
}

export function auditHoldsInWords({
  referenceWords,
  wordTimings,
  audio,
  sampleRate,
  correctRefIndices,
  paceId,
}: {
  referenceWords: WordWithRules[]
  wordTimings: ([number, number] | null)[] | null
  audio: Float32Array
  sampleRate: number
  correctRefIndices: Set<number>
  paceId?: PaceId
}): HoldAudit {
  const checks: DetectorCheck[] = []
  const metersByWord = new Map<number, RuleMeter[]>()
  if (!wordTimings) return { checks, metersByWord }

  referenceWords.forEach((word, refIndex) => {
    const rules = heldRulesOf(word, paceId)
    if (rules.length === 0) return
    const base = { refIndex, evidence: 'hold' as const }
    if (!correctRefIndices.has(refIndex)) {
      checks.push({ ...base, rules: rules.map((r) => r.rule), outcome: 'undecided', reason: 'word-not-confirmed' })
      return
    }
    const timing = wordTimings[refIndex]
    if (!timing) {
      checks.push({ ...base, rules: rules.map((r) => r.rule), outcome: 'undecided', reason: 'no-timing' })
      return
    }

    const from = Math.max(0, Math.round(timing[0] * sampleRate))
    const to = Math.min(audio.length, Math.round(timing[1] * sampleRate))
    const hop = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate))
    // The detector analyses a whole window at a time and discards anything shorter, so the
    // recording is walked in overlapping windows advanced by one hop — the same shape the live
    // path feeds it, where each animation frame hands over the analyser's whole buffer.
    if (to - from < FFT_SIZE + hop) {
      checks.push({ ...base, rules: rules.map((r) => r.rule), outcome: 'undecided', reason: 'weak-signal' })
      return
    }

    const tracker = new HoldTracker()
    for (let at = from; at + FFT_SIZE <= to; at += hop) {
      tracker.feed(audio.subarray(at, at + FFT_SIZE), sampleRate, HOP_MS)
    }
    const holds = tracker.finish()
    const meters = matchHoldsToRules(rules, holds, null, true)
    metersByWord.set(refIndex, meters)

    for (const meter of meters) {
      const performed = meter.requiredMs > 0 ? meter.heldMs / meter.requiredMs : 1
      checks.push({
        ...base,
        rules: [meter.rule],
        kind: meter.kind,
        outcome: meter.state === 'complete' ? 'met' : performed <= HOLD_ABSENT_BELOW ? 'absent' : 'short',
        measuredMs: Math.round(meter.heldMs),
        minimumMs: Math.round(meter.requiredMs),
      })
    }
  })

  return { checks, metersByWord }
}
