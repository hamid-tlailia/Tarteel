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
