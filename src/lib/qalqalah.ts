import type { WordWithRules } from './tajweed'

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
 * Heuristic check for qalqalah (the "echoing" bounce on ق ط ب ج د with sukoon): looks for
 * a brief near-silence (the letter's closure) immediately followed by a sharp rise in
 * energy (the release burst) within the word's own time span. No dip-then-bounce pattern
 * found → the qalqalah likely wasn't audible.
 *
 * This is a simple energy-envelope heuristic, not true plosive/burst detection — treat it
 * as an experimental signal. Requires forced-alignment word timing (see
 * scoreAndAlignReferenceWords in whisper.worker.ts); returns nothing if that's unavailable.
 */
export function detectQalqalahIssues(
  audio: Float32Array,
  referenceWords: WordWithRules[],
  wordTimings: ([number, number] | null)[],
  correctRefIndices: Set<number>,
): QalqalahAlert[] {
  const alerts: QalqalahAlert[] = []

  referenceWords.forEach((refWord, i) => {
    if (!refWord.rules.includes('qalqalah')) return
    if (!correctRefIndices.has(i)) return
    const timing = wordTimings[i]
    if (!timing) return

    const [start, end] = timing
    const startSample = Math.max(0, Math.round(start * SAMPLE_RATE))
    const endSample = Math.min(audio.length, Math.round(end * SAMPLE_RATE))
    if (endSample - startSample < FRAME_SAMPLES * MIN_SEGMENT_FRAMES) return

    const envelope = rmsEnvelope(audio.subarray(startSample, endSample))
    if (envelope.length < MIN_SEGMENT_FRAMES) return

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
    if (!hasBounce) {
      alerts.push({ refIndex: i, word: refWord.word })
    }
  })

  return alerts
}
