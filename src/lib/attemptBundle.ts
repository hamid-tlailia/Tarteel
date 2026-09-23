import type { PaceId } from './recitationPace'
import type { RiwayaId } from './riwaya'
import type { TajweedRuleId } from '../types/quran'
import type { TimedChunk } from '../asr/whisper.worker'

/**
 * One attempt, packaged so somebody else can judge it.
 *
 * Every threshold in this app is reasoned rather than measured. There is no corpus of real
 * recitations here to fit them to, so "the ghunnah must stand 6dB above the reciter's own
 * vowels" is an argument, not a measurement, and the only way to find out whether it is right
 * is to put real recitations — correct ones and ones with known, deliberate faults — in front
 * of a tajweed teacher, collect what they say, and see where the detectors disagree with them.
 *
 * That is the job this file exists for. A bundle holds everything needed to replay the
 * analysis *without* the model: the audio, the passage as the muṣḥaf marks it, the word
 * timings and confidences the ASR produced, and the conditions under which it was recited.
 * Replaying from the stored ASR output rather than re-running Whisper makes evaluation
 * deterministic — a threshold change is then the only thing that moves the numbers, which is
 * exactly what you want when you are trying to judge a threshold change.
 *
 * A teacher's labels go in `labels`, added after the fact. Nothing in the app ever writes
 * them, and the evaluator refuses to treat an unlabelled bundle as evidence of anything.
 */

export const BUNDLE_FORMAT = 'wartil-attempt-v1'

/** What a teacher says about one ruling, listening to the recording. */
export type LabelVerdict =
  /** Performed correctly. A detector that faults this is raising a false alarm — the costliest
   * error there is, because it corrects a reciter who was right. */
  | 'correct'
  /** Performed, but short of what the ruling asks. */
  | 'short'
  /** Not performed at all. */
  | 'absent'
  /** The teacher could not tell either — from this recording, nobody can. Excluded from every
   * count rather than guessed at. */
  | 'unsure'

export interface RuleLabel {
  /** Index into the passage's words, as the bundle lists them. */
  refIndex: number
  rule: TajweedRuleId
  verdict: LabelVerdict
  /** Free text from the teacher: what they heard, and anything the four verdicts miss. */
  noteAr?: string
}

export interface AttemptLabels {
  /** Who labelled it, and what qualifies them to. Not decoration: a corpus whose labellers
   * are unknown cannot be argued with. */
  labelledByAr: string
  /** ISO date. */
  labelledAt: string
  rules: RuleLabel[]
  /** Words the teacher says were misread as *text*, independently of any ruling. */
  misreadWordIndices?: number[]
}

export interface AttemptConditions {
  paceId: PaceId
  riwayaId: RiwayaId
  /** What the reciter says about this attempt — above all whether a fault was deliberate.
   * A corpus of nothing but correct recitations can only measure false alarms; one needs
   * planted faults to measure what the detectors miss. */
  intentAr?: string
  /** Free-text device and microphone, since both change every absolute level in the analysis. */
  deviceAr?: string
}

export interface AttemptAudio {
  sampleRate: number
  /** 16-bit PCM WAV, base64. The same samples the analysis saw, after conditioning and
   * silence trimming — not the raw microphone stream, so a replay sees what the detectors saw. */
  wavBase64: string
}

export interface AttemptBundle {
  format: typeof BUNDLE_FORMAT
  id: string
  recordedAt: string
  passage: {
    surah: number
    fromAyah: number
    toAyah: number
    /** Each ayah's text with the edition's tajweed markup intact, so the words and their
     * rulings can be rebuilt exactly as the app had them. */
    ayahMarkup: string[]
  }
  conditions: AttemptConditions
  /** What the ASR produced, so the replay needs no model. */
  asr: {
    text: string
    /** The free decode's per-word text and timestamps, kept so a replay aligns exactly as the
     * app did — reconstructing them by splitting the text would quietly change the alignment
     * and with it the verdicts under examination. */
    chunks: TimedChunk[]
    wordTimings: ([number, number] | null)[]
    wordConfidences: number[] | null
    orthographyVariant: string | null
  }
  audio: AttemptAudio
  /** What this build concluded, kept for the record. The evaluator recomputes rather than
   * trusting it — otherwise a bundle would freeze the very behaviour under examination. */
  appVerdict?: {
    faultedRules: { refIndex: number; rule: TajweedRuleId; outcome: string }[]
    undecidedRules: { refIndex: number; rule: TajweedRuleId; reason: string }[]
    wordsCorrect: number
    wordsReached: number
  }
  labels?: AttemptLabels
}

/** Minimal 16-bit PCM WAV encoder — enough for one mono recording. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true)
  }
  return bytes
}

export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sampleRate = view.getUint32(24, true)
  const dataLength = view.getUint32(40, true)
  const samples = new Float32Array(Math.floor(dataLength / 2))
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32768
  return { samples, sampleRate }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64 without assuming a browser or a Node Buffer — this file runs in both. */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? B64[c & 63] : '='
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0) << 6) |
      (i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0)
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

export function bundleAudio(samples: Float32Array, sampleRate: number): AttemptAudio {
  return { sampleRate, wavBase64: toBase64(encodeWav(samples, sampleRate)) }
}

export function readBundleAudio(audio: AttemptAudio): { samples: Float32Array; sampleRate: number } {
  return decodeWav(fromBase64(audio.wavBase64))
}

/** Whether a parsed object really is a bundle this build can replay. Deliberately strict:
 * a half-read file that silently evaluates as an empty attempt would quietly flatter every
 * threshold in the app. */
export function isAttemptBundle(value: unknown): value is AttemptBundle {
  if (!value || typeof value !== 'object') return false
  const b = value as Partial<AttemptBundle>
  return (
    b.format === BUNDLE_FORMAT &&
    typeof b.id === 'string' &&
    !!b.passage &&
    Array.isArray(b.passage.ayahMarkup) &&
    b.passage.ayahMarkup.length > 0 &&
    !!b.asr &&
    Array.isArray(b.asr.wordTimings) &&
    !!b.audio &&
    typeof b.audio.wavBase64 === 'string'
  )
}
