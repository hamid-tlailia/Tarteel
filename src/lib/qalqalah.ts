import type { WordWithRules } from './tajweed'
import type { DetectorCheck } from './findings'

const SAMPLE_RATE = 16000
const FRAME_SAMPLES = Math.round(SAMPLE_RATE * 0.01) // 10ms frames
const MIN_SEGMENT_FRAMES = 4
const SILENCE_RMS = 0.01
const BOUNCE_RATIO = 3

export interface QalqalahAlert {
  refIndex: number
  word: string
}

function rmsEnvelope(samples: Float32Array): number[] {
  const frames: number[] = []
  for (let i = 0; i < samples.length; i += FRAME_SAMPLES) {
    const end = Math.min(i + FRAME_SAMPLES, samples.length)
    let sumSquares = 0
    for (let j = i; j < end; j++) sumSquares += samples[j] * samples[j]
    frames.push(Math.sqrt(sumSquares / (end - i)))
  }
  return frames
}

/**
 * How quiet the quietest part of the recording is, as a fraction of SILENCE_RMS.
 *
 * A qalqalah is found by its closure — a brief near-silence inside the word — and a recording
 * whose own noise floor never gets that quiet cannot show one. Before this, such a recording
 * produced a confident "the qalqalah did not appear" on every qalqalah word in it, which is
 * the signature failure this build is meant to stop: the check was reporting its own blindness
 * as the reciter's mistake.
 */
const NOISY_FLOOR_RATIO = 0.8

/** The noise floor of the whole recording — the quietest tenth of its frames. */
function noiseFloor(audio: Float32Array): number {
  const envelope = rmsEnvelope(audio)
  if (envelope.length === 0) return Infinity
  const sorted = [...envelope].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.floor(sorted.length * 0.1) - 1)] ?? sorted[0]
}

/**
 * Heuristic check for qalqalah (the "echoing" bounce on ق ط ب ج د with sukoon): looks for
 * a brief near-silence (the letter's closure) immediately followed by a sharp rise in
 * energy (the release burst) within the word's own time span.
 *
 * Reports what it examined, not only what it faulted — a word it could not look at (no
 * timing, a span too brief to hold a closure, a recording whose noise floor hides one) comes
 * back undecided rather than silently passing or silently failing. See findings.ts.
 *
 * This is a simple energy-envelope heuristic, not true plosive/burst detection — treat it
 * as an experimental signal. Requires forced-alignment word timing (see
 * scoreAndAlignReferenceWords in whisper.worker.ts).
 */
export function auditQalqalah(
  audio: Float32Array,
  referenceWords: WordWithRules[],
  wordTimings: ([number, number] | null)[],
  correctRefIndices: Set<number>,
): DetectorCheck[] {
  const checks: DetectorCheck[] = []
  const floor = noiseFloor(audio)
  const floorHidesClosure = floor >= SILENCE_RMS * NOISY_FLOOR_RATIO

  referenceWords.forEach((refWord, i) => {
    if (!refWord.rules.includes('qalqalah')) return
    const base = { refIndex: i, rules: ['qalqalah' as const], evidence: 'burst' as const }
    if (!correctRefIndices.has(i)) {
      checks.push({ ...base, outcome: 'undecided', reason: 'word-not-confirmed' })
      return
    }
    const timing = wordTimings[i]
    if (!timing) {
      checks.push({ ...base, outcome: 'undecided', reason: 'no-timing' })
      return
    }

    const [start, end] = timing
    const startSample = Math.max(0, Math.round(start * SAMPLE_RATE))
    const endSample = Math.min(audio.length, Math.round(end * SAMPLE_RATE))
    if (endSample - startSample < FRAME_SAMPLES * MIN_SEGMENT_FRAMES) {
      checks.push({ ...base, outcome: 'undecided', reason: 'weak-signal' })
      return
    }

    const envelope = rmsEnvelope(audio.subarray(startSample, endSample))
    if (envelope.length < MIN_SEGMENT_FRAMES) {
      checks.push({ ...base, outcome: 'undecided', reason: 'weak-signal' })
      return
    }

    let minIndex = 0
    for (let k = 1; k < envelope.length; k++) {
      if (envelope[k] < envelope[minIndex]) minIndex = k
    }
    const minValue = envelope[minIndex]

    // Look across the whole rest of the word's span, not just a fixed window — a real
    // closure (the silent part of the letter) can run well past a short fixed lookahead.
    let maxAfterDip = 0
    for (let k = minIndex + 1; k < envelope.length; k++) {
      if (envelope[k] > maxAfterDip) maxAfterDip = envelope[k]
    }

    const hasBounce = minValue < SILENCE_RMS && maxAfterDip > minValue * BOUNCE_RATIO + 0.005
    if (hasBounce) {
      checks.push({ ...base, outcome: 'met' })
    } else if (floorHidesClosure) {
      // The closure that proves a qalqalah is a silence, and this recording has none to show:
      // its own quietest moment is as loud as the closure would be.
      checks.push({ ...base, outcome: 'undecided', reason: 'weak-signal' })
    } else {
      checks.push({ ...base, outcome: 'absent' })
    }
  })

  return checks
}

/** The faults inside the audit, in the shape the results card consumes. */
export function detectQalqalahIssues(
  audio: Float32Array,
  referenceWords: WordWithRules[],
  wordTimings: ([number, number] | null)[],
  correctRefIndices: Set<number>,
): QalqalahAlert[] {
  return auditQalqalah(audio, referenceWords, wordTimings, correctRefIndices)
    .filter((c) => c.outcome === 'short' || c.outcome === 'absent')
    .map((c) => ({ refIndex: c.refIndex, word: referenceWords[c.refIndex]?.word ?? '' }))
}
