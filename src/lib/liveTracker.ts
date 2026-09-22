import type { WordWithRules } from './tajweed'
import { expectedDurationBreakdown } from './wordTiming'
import type { PaceId } from './recitationPace'
import { heldRuleOf } from './acousticTajweed'
import type { TajweedRuleId } from '../types/quran'
import { HoldTracker } from './holdDetector'
import { heldRulesOf, matchHoldsToRules, unmetRules, type RuleMeter } from './ruleMeter'

export type LiveWordStatus = 'pending' | 'current' | 'excellent' | 'ok' | 'short' | 'long' | 'silent'

export interface LiveWordResult {
  status: LiveWordStatus
  measuredMs: number
  /**
   * The held rule this word owed and did not deliver, named the instant the word ends.
   *
   * Waiting for the final analysis to say a ghunnah was dropped teaches nothing while the
   * reciter is still reading, and someone testing the app by deliberately skipping a rule
   * gets no sign that it noticed until they stop. This is the timing evidence only — the
   * word was too short to have contained the hold — so it cannot see a madd that was held
   * for long enough but read wrong. The spectral check after recording still does that.
   */
  missed?: { rule: TajweedRuleId; kind: 'madd' | 'ghunnah'; severity: 'mild' | 'severe' }
  /**
   * One entry per held ruling in the word, in the order its letters run — what the coloured
   * bars under the word are drawn from. Empty for a word carrying no madd or ghunnah.
   */
  meters?: RuleMeter[]
}

/** Share of the obligation that must be performed live before the rule counts as delivered.
 * Looser than the post-hoc check in acousticTajweed.ts: this runs on microphone energy alone,
 * with word boundaries guessed from silence, so it should speak only when plainly right. */
const LIVE_HOLD_ENOUGH = 0.5
const LIVE_HOLD_ABSENT = 0.15

export interface LiveSnapshot {
  /** Index of the word currently being read, or the next unreached one. */
  cursor: number
  started: boolean
  finished: boolean
  words: LiveWordResult[]
  /** How long the word being recited right now has been voiced, and how long it should
   * take — together these drive the meter that shows a reciter how much of a madd is
   * still owed while they are still holding it. Zero when between words. */
  currentVoicedMs: number
  currentExpectedMs: number
  /** Further time this word's madd *may* be extended past `currentExpectedMs`, when a rule
   * permits more than its minimum. The meter shows this beyond the finish line, since
   * holding it is the reciter's choice and stopping at the minimum is not a fault. */
  currentOptionalMs: number
  /** One per held ruling of the word being recited, for the coloured bars beneath it. */
  currentRuleMeters: RuleMeter[]
}

/** Longest pause between two voiced stretches still counted as one word (ms). */
const GAP_MS = 150
/** Safety cap: force-close a word that's been open far longer than any madd could justify. */
const MAX_OVER_MS = 900
const START_THR = 0.012
/**
 * The longest gap between two energy frames still counted as elapsed recitation.
 *
 * It exists to stop a backgrounded tab, where frames stop arriving for seconds at a time,
 * from crediting all that silence to whatever word was open. But it was set at 90ms, barely
 * above a frame at 60fps, and a phone busy re-rendering the page delivered frames 100–200ms
 * apart — so the excess was discarded and every word measured short. Played at 8fps, a
 * recitation that takes 600ms per word measured about 420ms: a third of the time simply
 * vanished, and words a reciter held correctly were reported as rushed. 250ms still clamps a
 * hidden tab hard while treating an ordinary hitch as the real time it is.
 */
const MAX_FRAME_DT_MS = 250
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
  private optionalMs: number[]
  private breakdowns: ReturnType<typeof expectedDurationBreakdown>[] = []
  /** The held rulings of each word, precomputed since they depend only on text and pace. */
  private ruleSpecs: ReturnType<typeof heldRulesOf>[] = []
  /** Listens for the moments a sound is actually being held — see holdDetector.ts. */
  private holds = new HoldTracker()
  /**
   * Whether any caller has supplied raw audio, without which the hold detector hears
   * nothing and every ruling would look unperformed. A caller feeding energy alone still
   * gets word segmentation and the whole-word duration check; it simply gets no bars.
   */
  private sawSamples = false
  private tau: number
  private onWord: ((index: number, result: LiveWordResult) => void) | null

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
  /**
   * Bumped whenever something a React render depends on changes — a word opening or
   * closing, the first sound, the end of the recording. The caller can then re-render on
   * those moments alone instead of on a timer, and read the continuously-moving hold with
   * currentHold() every animation frame without going through React at all. Re-rendering
   * the page a dozen times a second to move one bar was what made the bar late: the
   * renders starved the very animation frames that feed this tracker, so the measurements
   * arrived in coarse jumps and the bar chased them.
   */
  private rev = 0
  /** Whether the word being recited has already met what its rules require. Crossing that
   * line is a discrete moment worth a render — it is when the meter completes and the word
   * turns green — so it is tracked rather than recomputed from a continuously-moving value
   * that React no longer sees. */
  private requiredMet = false

  constructor(
    words: WordWithRules[],
    tau = 0.45,
    onWord: ((index: number, result: LiveWordResult) => void) | null = null,
    /** The pace the reciter chose — it decides both how long a ḥaraka lasts and how many of
     * them each madd is owed, so the live meter fills toward the right target. */
    paceId?: PaceId,
  ) {
    this.words = words
    const breakdowns = words.map((w) => expectedDurationBreakdown(w, paceId))
    this.breakdowns = breakdowns
    this.ruleSpecs = words.map((w) => heldRulesOf(w, paceId))
    this.expectedMs = breakdowns.map((b) => b.total)
    this.optionalMs = breakdowns.map((b) => b.optionalExtraMs)
    this.tau = tau
    this.onWord = onWord
    this.results = words.map(() => ({ status: 'pending' as LiveWordStatus, measuredMs: 0 }))
  }

  /**
   * Feed one energy frame (rms 0..~1) with its timestamp in ms.
   *
   * `samples` are that frame's raw audio, which the hold detector needs: energy alone says a
   * sound is happening, and only its spectrum says the sound is being *held*. Optional, so a
   * caller with no audio path still gets word segmentation and duration checks.
   */
  feed(rms: number, tMs: number, samples?: Float32Array, sampleRate = 48000): void {
    if (this.finished || !this.words.length) return
    const dt = this.lastT ? Math.max(0, Math.min(MAX_FRAME_DT_MS, tMs - this.lastT)) : 16
    this.lastT = tMs

    const thr = Math.max(this.floorEma * 2.1, START_THR * 0.6, 0.007)
    if (rms < thr) this.floorEma = this.floorEma * 0.985 + Math.min(rms, this.floorEma) * 0.015 + 0.00002
    const voiced = rms > thr

    if (voiced) {
      if (!this.started && rms > START_THR) {
        this.started = true
        this.rev++
      }
      if (!this.inWord) {
        if (this.cursor + 1 >= this.words.length) return
        this.cursor++
        this.inWord = true
        this.voicedMs = 0
        this.silenceMs = 0
        this.results[this.cursor] = { status: 'current', measuredMs: 0 }
        this.requiredMet = false
        this.holds.reset()
        this.rev++
      }
      this.voicedMs += dt
      if (samples) {
        this.sawSamples = true
        this.holds.feed(samples, sampleRate, dt)
      }
      this.silenceMs = 0

      if (!this.requiredMet) {
        const required = (this.expectedMs[this.cursor] ?? 0) * this.scale
        if (required > 0 && this.voicedMs >= required) {
          this.requiredMet = true
          this.rev++
        }
      }

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

    // The pace this word is judged against must come from the *other* words. Folding this
    // word's own ratio in first drags the yardstick toward the very thing being measured: a
    // madd dropped outright then read as merely shortened, because the scale had already
    // moved half way to the rushed reading. Worse, a reciter skipping every obligation alike
    // would pull the scale down until nothing registered at all — the same blindness to a
    // uniform failure that the post-hoc check avoids by leaving the word out.
    // Read the holds before the tracker is reset for the next word.
    const meters = this.metersFor(i, true)
    const scaleBefore = this.scale
    if (measured >= MIN_VOICED_MS && this.expectedMs[i] > 0) {
      this.ratios.push(measured / this.expectedMs[i])
      if (this.ratios.length >= 2) this.scale = Math.min(1.8, Math.max(0.6, median(this.ratios)))
    }
    const expected = Math.max(60, Math.round(this.expectedMs[i] * this.scale))
    const status = classifyDuration(measured, expected, this.tau)
    // Where the rulings were measured one by one, that is the whole account — the
    // whole-word duration check is not consulted at all, and must not be.
    //
    // It asks whether the word lasted as long as its syllables and rules together imply,
    // which is a proxy, and a loose one: «عَمَّ» with its ghunnah held for a full two
    // ḥarakāt but its two vowels clipped comes in under the word's expected total and the
    // proxy calls the ghunnah short, though the bars show it was given in full. Direct
    // evidence about the ruling beats an inference from the word around it.
    const unmet = meters.length > 0 ? unmetRules(meters)[0] : undefined
    this.results[i] = {
      status,
      measuredMs: measured,
      meters,
      missed: unmet
        ? { rule: unmet.rule, kind: unmet.kind, severity: unmet.heldMs <= 0 ? 'severe' : 'mild' }
        : meters.length > 0
          ? undefined
          : (this.missedHold(i, measured, scaleBefore) ?? undefined),
    }

    this.inWord = false
    this.voicedMs = 0
    this.silenceMs = 0
    this.rev++
    this.onWord?.(i, this.results[i])
  }

  /**
   * Whether the word just closed had room for the hold its rules call for.
   *
   * Measured against the obligation itself — the extra time the rule adds — not against the
   * word's whole duration, for the same reason the post-hoc check is: on a long word,
   * dropping the madd shortens it by only a fraction, which any percentage of the total
   * would miss.
   */
  private missedHold(i: number, measuredMs: number, scale: number): LiveWordResult['missed'] | null {
    const word = this.words[i]
    const held = word ? heldRuleOf(word.rules) : null
    if (!held) return null
    const breakdown = this.breakdowns[i]
    if (!breakdown) return null

    const unheld = (held.kind === 'madd' ? breakdown.withoutMadd : breakdown.withoutGhunnah) * scale
    const obligation = breakdown.total * scale - unheld
    if (obligation <= 0) return null

    const performed = (measuredMs - unheld) / obligation
    if (performed >= LIVE_HOLD_ENOUGH) return null
    return {
      rule: held.rule,
      kind: held.kind,
      severity: performed <= LIVE_HOLD_ABSENT ? 'severe' : 'mild',
    }
  }

  /**
   * The state of each of this word's rulings, from the holds heard in it so far.
   *
   * `finished` decides what an unmatched ruling means: mid-word it has not been reached yet,
   * and after the word it was passed over.
   */
  private metersFor(index: number, finished: boolean): RuleMeter[] {
    const specs = this.ruleSpecs[index]
    if (!specs || specs.length === 0 || !this.sawSamples) return []
    const { holds, openStartMs, elapsedMs } = this.holds.current()
    const open =
      !finished && openStartMs !== null
        ? { startMs: openStartMs, elapsedMs, nasal: null }
        : null
    return matchHoldsToRules(specs, holds, open, finished)
  }

  /** Call when recording stops: closes any still-open word and freezes the tracker. */
  finish(): void {
    if (this.finished) return
    if (this.inWord) this.closeCurrent()
    this.finished = true
    this.rev++
  }

  /**
   * The bars for the word being recited right now, read fresh each animation frame.
   *
   * Separate from snapshot() because it is polled at display rate and must not allocate the
   * whole passage's state to move one bar — the same reason the hold meter is written
   * straight to the DOM rather than through React.
   */
  currentRuleMeters(): RuleMeter[] {
    if (!this.inWord || this.cursor < 0) return []
    return this.metersFor(this.cursor, false)
  }

  /** Changes only at the discrete moments listed on `rev`. Cheap enough to poll per frame. */
  revision(): number {
    return this.rev
  }

  /**
   * How long the word being recited *right now* has been voiced, against what its rules
   * require and what they merely permit beyond that. Null between words.
   *
   * Allocates one small object and reads no arrays, so the animation-frame loop can call it
   * at display rate and write the bar's width straight to the DOM.
   */
  currentHold(): { voicedMs: number; requiredMs: number; optionalMs: number } | null {
    if (!this.inWord || this.cursor < 0) return null
    return {
      voicedMs: this.voicedMs,
      requiredMs: Math.round((this.expectedMs[this.cursor] ?? 0) * this.scale),
      optionalMs: Math.round((this.optionalMs[this.cursor] ?? 0) * this.scale),
    }
  }

  snapshot(): LiveSnapshot {
    const nextIdx = this.inWord ? this.cursor : this.cursor + 1
    const expectedNow =
      this.inWord && this.cursor >= 0 ? Math.round((this.expectedMs[this.cursor] ?? 0) * this.scale) : 0
    const optionalNow =
      this.inWord && this.cursor >= 0 ? Math.round((this.optionalMs[this.cursor] ?? 0) * this.scale) : 0
    return {
      cursor: Math.min(nextIdx, this.words.length),
      started: this.started,
      finished: this.finished,
      words: this.results.map((r) => ({ ...r })),
      currentRuleMeters: this.inWord && this.cursor >= 0 ? this.metersFor(this.cursor, false) : [],
      currentVoicedMs: this.inWord ? Math.round(this.voicedMs) : 0,
      currentExpectedMs: expectedNow,
      currentOptionalMs: optionalNow,
    }
  }
}
