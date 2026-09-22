/**
 * The small amount of frequency-domain analysis the tajweed checks need.
 *
 * Everything else in this app measures *duration*, which is blind to a whole class of
 * faults: a ghunnah dropped from a word short enough that the missing two ḥarakāt fit
 * inside measurement error is, to a clock, indistinguishable from quick syllables. The
 * reported «عَمَّ» recited deliberately without its ghunnah sat ten milliseconds inside
 * what is physically possible, so no threshold on length could separate it from a fast
 * reciter without also accusing fast reciters. Telling them apart needs evidence of the
 * nasal sound itself.
 *
 * Deliberately minimal: a real-input FFT, framing, and two band measurements. No filter
 * banks, no cepstra, nothing that would need a corpus to calibrate.
 */

/** In-place radix-2 Cooley–Tukey FFT. `re`/`im` must be a power of two long. */
function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k]
        const aIm = im[i + k]
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe
        re[i + k] = aRe + bRe
        im[i + k] = aIm + bIm
        re[i + k + len / 2] = aRe - bRe
        im[i + k + len / 2] = aIm - bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

const FFT_SIZE = 512
const HANN = Float32Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE))

/** Power spectrum of one windowed frame, as bin → power. */
function powerSpectrum(samples: Float32Array, offset: number): Float32Array {
  const re = new Float32Array(FFT_SIZE)
  const im = new Float32Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) {
    const s = samples[offset + i] ?? 0
    re[i] = s * HANN[i]
  }
  fftInPlace(re, im)
  const power = new Float32Array(FFT_SIZE / 2)
  for (let k = 0; k < power.length; k++) power[k] = re[k] * re[k] + im[k] * im[k]
  return power
}

function bandPower(power: Float32Array, sampleRate: number, lowHz: number, highHz: number): number {
  const binHz = sampleRate / FFT_SIZE
  const from = Math.max(1, Math.round(lowHz / binHz))
  const to = Math.min(power.length - 1, Math.round(highHz / binHz))
  let sum = 0
  for (let k = from; k <= to; k++) sum += power[k]
  return sum / Math.max(1, to - from + 1)
}

/**
 * The nasal murmur's signature: almost all of its energy sits in a low resonance around
 * 250–350 Hz, while the higher formants are damped by the side branch of the mouth — so
 * the murmur is *bottom-heavy* in a way no open vowel is. Reported in dB, as the ratio of
 * the low band to the band above it.
 *
 * Read on its own this number says little: a close /u/ is bottom-heavy too, and a quiet
 * microphone shifts everything. It is only ever compared with the same reciter's own
 * non-nasal words in the same recording (see nasality.ts).
 */
const NASAL_LOW_HZ: [number, number] = [180, 480]
const NASAL_HIGH_HZ: [number, number] = [550, 3000]

/** The centre of gravity of the 700–2600 Hz region, which tracks the second formant and so
 * the front/back position of the tongue. Reported for the heaviness rules, which lower it. */
const CENTROID_HZ: [number, number] = [700, 2600]

/** Frames quieter than this carry no usable spectrum and are skipped. */
const FRAME_ENERGY_FLOOR = 1e-6

export interface SpanTimbre {
  /** The most nasal ~60ms stretch found in the span, in dB. Higher means more nasal. */
  peakNasalDb: number
  /** The span's median low-band dominance, in dB — what the word sounds like overall. */
  medianNasalDb: number
  /** Energy-weighted mean frequency of the F2 region, in Hz. Lower means further back. */
  centroidHz: number
  /** How many frames were loud enough to measure. Zero means the span told us nothing. */
  voicedFrames: number
}

const HOP_SAMPLES = 160 // 10ms at 16kHz
/** A ghunnah is held for about two ḥarakāt; a sixth of a second of it is enough to see. */
const SUSTAIN_FRAMES = 6

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Measures one time span of the recording. Returns zero voiced frames if it is too short
 * or too quiet to say anything, which callers must treat as "no evidence", not as a fault. */
export function analyzeSpan(audio: Float32Array, sampleRate: number, startS: number, endS: number): SpanTimbre {
  const from = Math.max(0, Math.round(startS * sampleRate))
  const to = Math.min(audio.length, Math.round(endS * sampleRate))
  const empty: SpanTimbre = { peakNasalDb: 0, medianNasalDb: 0, centroidHz: 0, voicedFrames: 0 }
  if (to - from < FFT_SIZE) return empty

  const nasalDb: number[] = []
  const centroids: number[] = []
  const weights: number[] = []
  for (let offset = from; offset + FFT_SIZE <= to; offset += HOP_SAMPLES) {
    const power = powerSpectrum(audio, offset)
    const low = bandPower(power, sampleRate, ...NASAL_LOW_HZ)
    const high = bandPower(power, sampleRate, ...NASAL_HIGH_HZ)
    if (low + high < FRAME_ENERGY_FLOOR) continue
    nasalDb.push(10 * Math.log10((low + FRAME_ENERGY_FLOOR) / (high + FRAME_ENERGY_FLOOR)))

    const binHz = sampleRate / FFT_SIZE
    let weighted = 0
    let total = 0
    for (let k = Math.round(CENTROID_HZ[0] / binHz); k <= Math.round(CENTROID_HZ[1] / binHz); k++) {
      const p = power[k] ?? 0
      weighted += p * k * binHz
      total += p
    }
    if (total > 0) {
      centroids.push(weighted / total)
      weights.push(total)
    }
  }
  if (nasalDb.length === 0) return empty

  // The loudest *sustained* nasal stretch, not the single best frame — one frame can be a
  // click or a moment of low pitch, while a ghunnah is held.
  let peak = -Infinity
  const window = Math.min(SUSTAIN_FRAMES, nasalDb.length)
  for (let i = 0; i + window <= nasalDb.length; i++) {
    let sum = 0
    for (let k = i; k < i + window; k++) sum += nasalDb[k]
    peak = Math.max(peak, sum / window)
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0)
  return {
    peakNasalDb: Number.isFinite(peak) ? peak : nasalDb[0],
    medianNasalDb: median(nasalDb),
    centroidHz: totalWeight > 0 ? centroids.reduce((sum, c, i) => sum + c * weights[i], 0) / totalWeight : 0,
    voicedFrames: nasalDb.length,
  }
}
