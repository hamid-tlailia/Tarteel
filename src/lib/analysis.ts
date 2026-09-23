import type { WordWithRules } from './tajweed'
import type { TimedChunk } from '../asr/whisper.worker'
import type { PaceId, PaceProfile } from './recitationPace'
import type { ReferenceTiming } from './referenceTiming'
import { followScore } from './referenceTiming'
import { alignWords, type AlignedWord } from './alignment'
import { collapseRepeatedWords } from './repetition'
import { scoreTranscriptMatch } from './transcriptMatch'
import { normalizeArabic } from './arabicText'
import { buildWordVerdicts, PASSAGE_MATCH_FLOOR, type AyahRange, type WordVerdict } from './verdicts'
import {
  auditHeldRulesForced,
  auditHeldRulesFromFreeDecode,
  detectRecitedPace,
  faultsFrom,
  type AcousticAlert,
} from './acousticTajweed'
import { auditQalqalah, type QalqalahAlert } from './qalqalah'
import { auditGhunnahNasality, measureWordTimbre, type NasalityAlert, type TimbreMeasurement } from './nasality'
import { buildTajweedReport, type DetectorCheck, type TajweedReport } from './findings'
import { auditHoldsInWords } from './holdAudit'
import type { RuleMeter } from './ruleMeter'

/**
 * The whole judgement, in one place: transcript → words → rulings → report.
 *
 * It lives here rather than inside the practice screen because two callers need to run
 * *exactly* the same analysis. The screen is one. The other is the evaluation harness (see
 * evaluation.ts), which replays recorded attempts against a teacher's labels to find out
 * where these detectors are wrong. A harness that measured a reimplementation of the pipeline
 * would measure the reimplementation, and every threshold it endorsed would be endorsed for
 * code no reciter ever runs.
 */

export interface AnalysisInput {
  referenceWords: WordWithRules[]
  ayahRanges: AyahRange[]
  /** The free decode's text, and its per-word chunks where available. */
  text: string
  chunks: TimedChunk[]
  wordConfidences: number[] | null
  /** Forced-alignment timing, one span per *reference* word. Null when that pass failed. */
  wordTimings: ([number, number] | null)[] | null
  /** The conditioned, trimmed samples the analysis is made on. */
  audio: Float32Array
  sampleRate: number
  paceId?: PaceId
  /** An accredited reciter's own timings for this passage, when one has been aligned. */
  reference?: ReferenceTiming | null
  /** How loud the recording was before the app scaled it up. Below the floor, no acoustic
   * claim about it is evidence of anything. */
  inputRms?: number | null
}

export interface AnalysisResult {
  /** The transcription as it should be shown — hallucination loops already collapsed. */
  hypothesis: string
  aligned: AlignedWord[]
  verdicts: WordVerdict[]
  /** How much this transcription looks like the selected passage at all. */
  passageMatch: number
  timbre: (TimbreMeasurement | null)[]
  checks: DetectorCheck[]
  report: TajweedReport
  acousticAlerts: AcousticAlert[]
  qalqalahAlerts: QalqalahAlert[]
  nasalityAlerts: NasalityAlert[]
  recitedPace: { pace: PaceProfile; harakaMs: number; matchesSelected: boolean } | null
  follow: number | null
  /** The per-ruling meters measured from the recording, so the results can show the same bars
   * the live view used to — this time filled from the sound itself. */
  metersByWord: Map<number, RuleMeter[]>
  /** The chunks after collapsing, since callers that display or store them want these. */
  chunks: TimedChunk[]
}

/** The level below which the recorder warns that the microphone was too quiet. */
export const WEAK_INPUT_RMS = 0.015

function hypWordsFrom(text: string, chunks: TimedChunk[]) {
  if (chunks.length > 0) {
    const raw = chunks.map((c) => c.text.trim())
    return { raw, normalized: raw.map(normalizeArabic) }
  }
  const raw = text.split(/\s+/).filter(Boolean)
  return { raw, normalized: raw.map(normalizeArabic) }
}

export function analyzeRecitation(input: AnalysisInput): AnalysisResult {
  const { referenceWords, ayahRanges, paceId, reference } = input
  const referenceNormalized = referenceWords.map((w) => normalizeArabic(w.word))

  const { raw, normalized } = hypWordsFrom(input.text, input.chunks)
  // Defend against ASR hallucination loops (the same word repeated dozens of times over a
  // silent stretch) before they ever reach the aligner.
  const collapsed = collapseRepeatedWords(raw, normalized, input.chunks)
  const aligned = alignWords(referenceNormalized, collapsed.normalized)
  const passageMatch = scoreTranscriptMatch(collapsed.normalized, referenceNormalized).score
  const verdicts = buildWordVerdicts(aligned, input.wordConfidences, referenceWords.length, ayahRanges)
  const correctRefIndices = new Set(verdicts.filter((v) => v.status === 'correct').map((v) => v.refIndex))

  // What the words actually *sounded* like, as opposed to how long they took — the only
  // evidence that can settle a ghunnah on a short word. See spectral.ts and nasality.ts.
  const timbre = input.wordTimings
    ? measureWordTimbre(input.audio, input.sampleRate, input.wordTimings)
    : []

  // Forced-alignment timing (precise, from the known text) is preferred; fall back to the
  // free decode's approximate word timestamps when it isn't available this time.
  const durationChecks = input.wordTimings
    ? auditHeldRulesForced(referenceWords, input.wordTimings, correctRefIndices, paceId, reference)
    : collapsed.chunks.length > 0
      ? auditHeldRulesFromFreeDecode(aligned, referenceWords, collapsed.chunks, correctRefIndices, paceId)
      : []
  const qalqalahChecks = input.wordTimings
    ? auditQalqalah(input.audio, referenceWords, input.wordTimings, correctRefIndices)
    : []
  const nasalityChecks = auditGhunnahNasality(referenceWords, timbre, correctRefIndices)
  // The rulings measured by the sound they are made of, rather than by the length of the word
  // around them — the only instrument that can resolve a two-ḥaraka madd. See holdAudit.ts.
  const holdAudit = auditHoldsInWords({
    referenceWords,
    wordTimings: input.wordTimings,
    audio: input.audio,
    sampleRate: input.sampleRate,
    correctRefIndices,
    paceId,
  })
  const checks = [...holdAudit.checks, ...durationChecks, ...qalqalahChecks, ...nasalityChecks]

  const report = buildTajweedReport({
    referenceWords,
    verdicts,
    checks,
    passageRecognized: passageMatch >= PASSAGE_MATCH_FLOOR,
    audioUsable: input.inputRms === null || input.inputRms === undefined || input.inputRms >= WEAK_INPUT_RMS,
  })

  return {
    hypothesis: collapsed.raw.join(' ') || input.text,
    aligned,
    verdicts,
    passageMatch,
    timbre,
    checks,
    report,
    acousticAlerts: faultsFrom(durationChecks, referenceWords),
    qalqalahAlerts: qalqalahChecks
      .filter((c) => c.outcome === 'short' || c.outcome === 'absent')
      .map((c) => ({ refIndex: c.refIndex, word: referenceWords[c.refIndex]?.word ?? '' })),
    nasalityAlerts: nasalityChecks
      .filter((c) => c.outcome === 'short' || c.outcome === 'absent')
      .map((c) => ({
        refIndex: c.refIndex,
        word: referenceWords[c.refIndex]?.word ?? '',
        rule: c.rules[0],
        measuredDb: c.measuredDb ?? 0,
        baselineDb: c.baselineDb ?? 0,
        requiredDb: c.requiredDb ?? 0,
        severity: c.outcome === 'absent' ? ('severe' as const) : ('mild' as const),
      })),
    recitedPace: input.wordTimings
      ? detectRecitedPace(referenceWords, input.wordTimings, correctRefIndices, paceId)
      : null,
    follow:
      input.wordTimings && reference ? followScore(referenceWords, input.wordTimings, reference) : null,
    chunks: collapsed.chunks,
    metersByWord: holdAudit.metersByWord,
  }
}
