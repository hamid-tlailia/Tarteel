const TARGET_SAMPLE_RATE = 16000

/** Decodes a recorded audio Blob into mono 16kHz PCM, the format Whisper expects. */
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
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    this.chunks = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
    this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data)
    }
    this.mediaRecorder.start()
  }

  /** Flushes whatever has been recorded so far into a Blob, without stopping the recording.
   * Used to poll a "live" snapshot of the audio while the reciter is still speaking. */
  snapshot(): Promise<Blob | null> {
    const recorder = this.mediaRecorder
    if (!recorder || recorder.state !== 'recording') return Promise.resolve(null)
    return new Promise((resolve) => {
      const onData = () => {
        recorder.removeEventListener('dataavailable', onData)
        resolve(this.chunks.length > 0 ? new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }) : null)
      }
      recorder.addEventListener('dataavailable', onData)
      recorder.requestData()
    })
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
