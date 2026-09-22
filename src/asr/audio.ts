/** The rate every analysis downstream assumes, since the ASR is fed at it. */
export const TARGET_SAMPLE_RATE = 16000

/** Decodes a recorded audio Blob into mono 16kHz PCM, the format Whisper expects. Also used
 * for an accredited reciter's published mp3, which arrives at 128kbps stereo 44.1kHz. */
export async function decodeToPcm16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer()
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const decodeCtx = new AudioCtx()
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0))
  await decodeCtx.close()

  if (decoded.sampleRate === TARGET_SAMPLE_RATE && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0)
  }

  const durationSeconds = decoded.duration
  const offline = new OfflineAudioContext(1, Math.ceil(durationSeconds * TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start(0)
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

/**
 * Trims leading/trailing near-silence from 16kHz PCM using short-frame RMS energy.
 * A "live" snapshot taken mid-recording is often speech followed by a long silent tail
 * (the reciter pausing while the mic keeps running) — feeding that straight to Whisper is
 * a classic trigger for hallucinated repeated-word loops, so we cut the dead air first.
 * Returns an empty array when the whole clip is silence.
 */
export function trimSilence(pcm: Float32Array, sampleRate = TARGET_SAMPLE_RATE): Float32Array {
  const frameSize = Math.round(sampleRate * 0.03)
  const threshold = 0.012
  const padSamples = Math.round(sampleRate * 0.25)

  let firstActiveStart = -1
  let lastActiveEnd = -1
  for (let start = 0; start < pcm.length; start += frameSize) {
    const end = Math.min(start + frameSize, pcm.length)
    let sumSquares = 0
    for (let i = start; i < end; i++) sumSquares += pcm[i] * pcm[i]
    const rms = Math.sqrt(sumSquares / (end - start))
    if (rms > threshold) {
      if (firstActiveStart === -1) firstActiveStart = start
      lastActiveEnd = end
    }
  }

  if (firstActiveStart === -1) return pcm.slice(0, 0)

  const start = Math.max(0, firstActiveStart - padSamples)
  const end = Math.min(pcm.length, lastActiveEnd + padSamples)
  return pcm.slice(start, end)
}

export class MicRecorder {
  private mediaRecorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private stream: MediaStream | null = null

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      /**
       * Every one of the browser's "helpful" voice filters is turned off, deliberately.
       *
       * They are tuned for conversation over a network, and each of them damages exactly
       * what this app measures. Noise suppression treats a steady spectrum as stationary
       * noise and attenuates it — which is a madd held for four or six ḥarakāt, and which
       * hits the low-frequency band the ghunnah check reads hardest of all. Automatic gain
       * control rewrites the level continuously, so the adaptive noise floor the live
       * tracker segments words with is chasing the processor rather than the voice, and the
       * energy comparisons between words stop meaning anything. Echo cancellation has
       * nothing to cancel here, since nothing is playing back.
       *
       * The cost is that a noisy room stays noisy. That is the right trade: a recitation
       * measured through a filter that shortens held sounds is worse than one measured
       * honestly in a noisy room, and the app already tells a reciter when the input is too
       * quiet to work with.
       */
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    this.chunks = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
    this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.mediaRecorder.start()
  }

  /** The live microphone stream, for attaching a real-time analyser (see liveTracker.ts) —
   * null before start()/after stop()/cancel(). */
  getStream(): MediaStream | null {
    return this.stream
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const recorder = this.mediaRecorder
      if (!recorder) {
        reject(new Error('لم يتم بدء التسجيل'))
        return
      }
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' })
        this.stream?.getTracks().forEach((t) => t.stop())
        resolve(blob)
      }
      recorder.stop()
    })
  }

  cancel(): void {
    this.mediaRecorder?.stop()
    this.stream?.getTracks().forEach((t) => t.stop())
  }
}

/**
 * Conditions a recording before it reaches the model.
 *
 * Two things, both cheap and both about giving the model the signal it was trained on.
 *
 * A DC offset — a constant added to every sample, common on phone microphones — moves the
 * whole waveform off zero. It is inaudible, but it inflates every RMS measurement this app
 * takes (a silent frame is no longer near zero) and puts energy at 0 Hz that the spectral
 * analysis then reads as low-frequency content, which is precisely the band the ghunnah
 * check lives in.
 *
 * Level is the other. Whisper's log-mel front end has a floor, and a recitation captured
 * with the phone on a desk can sit far enough below it that quiet consonants disappear
 * into the floor entirely — which looks exactly like mishearing. Now that automatic gain
 * control is off (see MicRecorder), nothing else is going to fix that, so the whole clip is
 * scaled by one constant to a workable level. One constant, not a moving one: a
 * compressor would change the relative loudness of held sounds and undo the measurements
 * this app exists to take.
 */
const TARGET_RMS = 0.08
const PEAK_CEILING = 0.95
/**
 * Below this the clip is room noise, and scaling it up would only amplify the room.
 *
 * Set at roughly the level a quiet room records at, not at the level a quiet *recitation*
 * does. The first attempt put it at 0.002, which is about -54dBFS — well within the range a
 * phone lying on a desk captures a soft reciter at, so exactly the recordings that most
 * needed lifting were classified as silence and left alone.
 */
const NOISE_RMS = 0.0008
/**
 * The most the level may be raised.
 *
 * Without it, a recording just above the noise floor would be multiplied by a hundred, and
 * what comes up with it is the room: a fan, traffic, the phone's own preamp hiss. Past this
 * point the recording is not quiet, it is empty, and the honest answer is to say so rather
 * than to manufacture a signal — which is why the measured input level is reported back.
 */
const MAX_GAIN = 20

export interface ConditionedAudio {
  pcm: Float32Array
  /** What the recording measured before scaling — surfaced so a reciter can be told their
   * microphone is too quiet rather than silently having it amplified. */
  inputRms: number
  gain: number
}

export function conditionForAsr(pcm: Float32Array): ConditionedAudio {
  if (pcm.length === 0) return { pcm, inputRms: 0, gain: 1 }

  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]
  const dc = sum / pcm.length

  let sumSquares = 0
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] - dc
    sumSquares += v * v
    const abs = Math.abs(v)
    if (abs > peak) peak = abs
  }
  const inputRms = Math.sqrt(sumSquares / pcm.length)
  if (inputRms < NOISE_RMS || peak <= 0) {
    // Nothing worth amplifying. Still remove the offset, so the measurements downstream are
    // taken on a waveform centred at zero.
    const centred = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) centred[i] = pcm[i] - dc
    return { pcm: centred, inputRms, gain: 1 }
  }

  // Never so much gain that the loudest moment clips: a clipped peak is a burst of harmonics
  // the model has to read through, and it would land on the loudest syllable of the passage.
  const gain = Math.min(TARGET_RMS / inputRms, PEAK_CEILING / peak, MAX_GAIN)
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] - dc) * gain
  return { pcm: out, inputRms, gain }
}
