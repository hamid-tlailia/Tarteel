/**
 * Finding, live, the moments a reciter is *holding* a sound.
 *
 * The live tracker segments words by silence. Inside a word there is no silence, so energy
 * alone cannot say which letter is being uttered — and identifying letters would need a
 * phoneme model this app does not have.
 *
 * It does not need one. What the tajweed meter has to know is not *which letter* but *when a
 * sound is being held*, and that is directly measurable: a madd is a sustained vowel and a
 * ghunnah a sustained nasal murmur, both of which hold their spectrum nearly still, while
 * ordinary letters change it several times a second. So this watches the spectrum's rate of
 * change — its flux — and calls a stretch a hold when the flux stays low and the energy
 * stays up.
 *
 * The holds found inside a word then match, *in order*, the rule spans the muṣḥaf gives for
 * that word: first hold to first rule, second to second. Their order is fixed by the text,
 * which is what makes the match reliable without knowing any letter's identity.
 */

const FFT_SIZE = 512
const HANN = Float32Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE))

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

/** Bands used to tell a nasal hold from an oral one — the same signature as spectral.ts. */
const NASAL_LOW: [number, number] = [180, 480]
const NASAL_HIGH: [number, number] = [550, 3000]

/**
 * Below this normalized spectral change, the sound is not moving — it is being held.
 *
 * Reasoned rather than fitted: a sustained vowel's spectrum changes only with the small
 * wobble of the voice, while a transition between letters redraws it entirely. The gap
 * between the two is wide, so the exact value matters less than being clearly inside it.
 */
const HOLD_FLUX_MAX = 0.22
/** A hold shorter than this is a passing steady moment, not a performed ruling. */
const MIN_HOLD_MS = 90
/** Frames quieter than this carry no usable spectrum. */
const FRAME_ENERGY_FLOOR = 1e-6
/** Above this low-band dominance, relative to the reciter's own oral sounds, a hold is nasal. */
const NASAL_MARGIN_DB = 6

export interface Hold {
  /** Milliseconds from the start of the word, as fed. */
  startMs: number
  endMs: number
  /** Whether the held sound was nasal — a ghunnah rather than a madd. Null when there was
   * no oral baseline in this word to compare against. */
  nasal: boolean | null
  /** How bottom-heavy the hold was, in dB, for the diagnostics. */
  nasalDb: number
}

/**
 * Tracks one word as it is recited, frame by frame, and reports the holds found in it.
 *
 * Fed the same RMS the live tracker uses plus the raw samples of that frame, so the caller
 * does not have to keep a second audio path open.
 */
export class HoldTracker {
  private prevSpectrum: Float32Array | null = null
  private elapsedMs = 0
  private openStartMs: number | null = null
  private openNasalDb: number[] = []
  private oralNasalDb: number[] = []
  private holds: Hold[] = []

  /** Starts a new word. */
  reset(): void {
    this.prevSpectrum = null
    this.elapsedMs = 0
    this.openStartMs = null
    this.openNasalDb = []
    this.oralNasalDb = []
    this.holds = []
  }

  /**
   * Feeds one frame of the word being recited.
   *
   * @param samples time-domain samples, at least FFT_SIZE of them
   * @param sampleRate the rate they were captured at
   * @param dtMs how long this frame represents
   */
  feed(samples: Float32Array, sampleRate: number, dtMs: number): void {
    this.elapsedMs += dtMs
    if (samples.length < FFT_SIZE) return

    const re = new Float32Array(FFT_SIZE)
    const im = new Float32Array(FFT_SIZE)
    const offset = samples.length - FFT_SIZE
    for (let i = 0; i < FFT_SIZE; i++) re[i] = samples[offset + i] * HANN[i]
    fftInPlace(re, im)

    const bins = FFT_SIZE / 2
    const magnitude = new Float32Array(bins)
    let total = 0
    for (let k = 0; k < bins; k++) {
      magnitude[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      total += magnitude[k]
    }
    if (total < FRAME_ENERGY_FLOOR) {
      this.closeHold()
      this.prevSpectrum = null
      return
    }
    // Normalized, so flux measures a change in *shape* rather than in loudness. Getting
    // louder while holding the same vowel is still a hold.
    for (let k = 0; k < bins; k++) magnitude[k] /= total

    const binHz = sampleRate / FFT_SIZE
    const band = (lo: number, hi: number) => {
      let sum = 0
      const from = Math.max(1, Math.round(lo / binHz))
      const to = Math.min(bins - 1, Math.round(hi / binHz))
      for (let k = from; k <= to; k++) sum += magnitude[k] * magnitude[k]
      return sum / Math.max(1, to - from + 1)
    }
    const nasalDb =
      10 * Math.log10((band(...NASAL_LOW) + FRAME_ENERGY_FLOOR) / (band(...NASAL_HIGH) + FRAME_ENERGY_FLOOR))

    if (this.prevSpectrum) {
      let flux = 0
      for (let k = 0; k < bins; k++) flux += Math.abs(magnitude[k] - this.prevSpectrum[k])
      if (flux <= HOLD_FLUX_MAX) {
        if (this.openStartMs === null) this.openStartMs = this.elapsedMs - dtMs
        this.openNasalDb.push(nasalDb)
      } else {
        this.closeHold()
        this.oralNasalDb.push(nasalDb)
      }
    }
    this.prevSpectrum = magnitude
  }

  private closeHold(): void {
    const start = this.openStartMs
    this.openStartMs = null
    const levels = this.openNasalDb
    this.openNasalDb = []
    if (start === null) return
    const durationMs = this.elapsedMs - start
    if (durationMs < MIN_HOLD_MS || levels.length === 0) return

    const nasalDb = levels.reduce((sum, v) => sum + v, 0) / levels.length
    this.holds.push({ startMs: start, endMs: this.elapsedMs, nasal: null, nasalDb })
  }

  /** Closes the word and returns the holds found in it, in the order they occurred. */
  finish(): Hold[] {
    this.closeHold()
    return this.classify()
  }

  /** The holds so far, including the one still open — for driving the meter live. */
  current(): { holds: Hold[]; openStartMs: number | null; elapsedMs: number } {
    return { holds: this.classify(), openStartMs: this.openStartMs, elapsedMs: this.elapsedMs }
  }

  /**
   * Decides which holds were nasal, by comparing each against this word's own non-held
   * sounds. Absolute levels say nothing across microphones and voices, so with no oral
   * frames to compare against nothing is claimed either way.
   */
  private classify(): Hold[] {
    if (this.oralNasalDb.length === 0) return this.holds.map((h) => ({ ...h }))
    const sorted = [...this.oralNasalDb].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    const baseline = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    return this.holds.map((h) => ({ ...h, nasal: h.nasalDb >= baseline + NASAL_MARGIN_DB }))
  }
}
