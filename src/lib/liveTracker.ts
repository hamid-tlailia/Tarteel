import type { WordWithRules } from './tajweed'
import { expectedWordDurationMs } from './wordTiming'

export type LiveWordStatus = 'pending' | 'current' | 'excellent' | 'ok' | 'short' | 'long' | 'silent'

export interface LiveWordResult {
  status: LiveWordStatus
  measuredMs: number
}

export interface LiveSnapshot {
  /** Index of the word currently being read, or the next unreached one. */
  cursor: number
  started: boolean
  finished: boolean
  words: LiveWordResult[]
}

/** Longest pause between two voiced stretches still counted as one word (ms). */
const GAP_MS = 150
/** Safety cap: force-close a word that's been open far longer than any madd could justify. */
const MAX_OVER_MS = 900
const START_THR = 0.012
const MIN_VOICED_MS = 70

function tauTolerance(tau: number): number {
  return 0.6 - 0.45 * Math.min(1, Math.max(0, tau))
}

function classifyDuration(measuredMs: number, expectedMs: number, tau: number): LiveWordStatus {
  if (measuredMs < 70) return 'silent'
  const tol = tauTolerance(tau)
  const r = measuredMs / Math.max(60, expectedMs)
  if (r < 1 - tol) return 'short'
  if (r > 1 + tol) return 'long'
  if (Math.abs(r - 1) <= 0.35 * tol) return 'excellent'
  return 'ok'
}

function median(values: number[]): number {
  if (!values.length) return 1
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Real-time per-word timing tracker driven purely by microphone energy (RMS) — no ASR
 * involved. It segments words by silence gaps and classifies each closed word's duration
 * against a rule-derived expected duration (see wordTiming.ts), adapting to the reciter's
 * own pace via a running speed-scale factor (median of measured/expected ratios so far).
 *
 * This is what drives the *live* per-ayah reveal and instant madd/ghunnah/qalqalah timing
 * feedback while recording, replacing the old approach of re-running Whisper every few
 * seconds on the growing (and often mostly-silent) live recording — which was the root
 * cause of the ASR hallucination bug (repeated-word spam) fixed earlier. Whisper now runs
 * exactly once, on the complete clean recording after the reciter stops, for word
 * *correctness* (see whisper.worker.ts's forced-decoding pass) — this tracker cannot tell a
 * substituted word from a correct one, only whether *something* was said in roughly the
 * right span; it assumes the reciter is progressing through the reference words in order.
 */
export class LiveTajweedTracker {
  private words: WordWithRules[]
  private expectedMs: number[]
  private tau: number
  private onWord: ((index: number, status: LiveWordStatus, measuredMs: number) => void) | null

  private cursor = -1
  private inWord = false
  private started = false
  private finished = false
  private voicedMs = 0
  private silenceMs = 0
  private lastT = 0
  /** Adaptive noise floor — rises slowly with ambient noise, never below a hard minimum. */
  private floorEma = 0.0045
  private ratios: number[] = []
  private scale = 1
  private results: LiveWordResult[]

  constructor(
    words: WordWithRules[],
    tau = 0.45,
    onWord: ((index: number, status: LiveWordStatus, measuredMs: number) => void) | null = null,
  ) {
    this.words = words
    this.expectedMs = words.map(expectedWordDurationMs)
    this.tau = tau
    this.onWord = onWord
    this.results = words.map(() => ({ status: 'pending' as LiveWordStatus, measuredMs: 0 }))
  }

  /** Feed one energy frame (rms 0..~1) with its timestamp in ms. */
  feed(rms: number, tMs: number): void {
    if (this.finished || !this.words.length) return
    const dt = this.lastT ? Math.max(0, Math.min(90, tMs - this.lastT)) : 16
    this.lastT = tMs

    const thr = Math.max(this.floorEma * 2.1, START_THR * 0.6, 0.007)
    if (rms < thr) this.floorEma = this.floorEma * 0.985 + Math.min(rms, this.floorEma) * 0.015 + 0.00002
    const voiced = rms > thr

    if (voiced) {
      if (!this.started && rms > START_THR) this.started = true
      if (!this.inWord) {
        if (this.cursor + 1 >= this.words.length) return
        this.cursor++
        this.inWord = true
        this.voicedMs = 0
        this.silenceMs = 0
        this.results[this.cursor] = { status: 'current', measuredMs: 0 }
      }
      this.voicedMs += dt
      this.silenceMs = 0

      const exp = this.expectedMs[this.cursor]
      if (this.voicedMs > exp * 2.4 + MAX_OVER_MS) this.closeCurrent()
    } else if (this.inWord) {
      this.silenceMs += dt
      if (this.silenceMs >= GAP_MS) this.closeCurrent()
    }
  }

  private closeCurrent(): void {
    const i = this.cursor
    if (i < 0 || i >= this.words.length) {
      this.inWord = false
      return
    }
    const measured = Math.round(this.voicedMs)
    if (measured >= MIN_VOICED_MS && this.expectedMs[i] > 0) {
      this.ratios.push(measured / this.expectedMs[i])
      if (this.ratios.length >= 2) this.scale = Math.min(1.8, Math.max(0.6, median(this.ratios)))
    }
    const expected = Math.max(60, Math.round(this.expectedMs[i] * this.scale))
    const status = classifyDuration(measured, expected, this.tau)
    this.results[i] = { status, measuredMs: measured }

    this.inWord = false
    this.voicedMs = 0
    this.silenceMs = 0
    this.onWord?.(i, status, measured)
  }

  /** Call when recording stops: closes any still-open word and freezes the tracker. */
  finish(): void {
    if (this.finished) return
    if (this.inWord) this.closeCurrent()
    this.finished = true
  }

  snapshot(): LiveSnapshot {
    const nextIdx = this.inWord ? this.cursor : this.cursor + 1
    return {
      cursor: Math.min(nextIdx, this.words.length),
      started: this.started,
      finished: this.finished,
      words: this.results.map((r) => ({ ...r })),
    }
  }
}
