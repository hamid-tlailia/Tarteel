/// <reference lib="webworker" />
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

env.allowLocalModels = false

const MODEL_ID = 'onnx-community/whisper-base'

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null

type IncomingMessage =
  | { type: 'load' }
  | { type: 'transcribe'; audio: Float32Array; requestId: number }

type ProgressInfo = { status: string; file?: string; progress?: number; loaded?: number; total?: number }

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data
  if (msg.type === 'load') {
    try {
      transcriberPromise ??= pipeline('automatic-speech-recognition', MODEL_ID, {
        dtype: 'q8',
        progress_callback: (progress: ProgressInfo) => {
          self.postMessage({ type: 'progress', progress })
        },
      }) as Promise<AutomaticSpeechRecognitionPipeline>
      await transcriberPromise
      self.postMessage({ type: 'ready' })
    } catch (err) {
      self.postMessage({ type: 'error', error: (err as Error).message })
    }
    return
  }

  if (msg.type === 'transcribe') {
    try {
      const transcriber = await (transcriberPromise ?? Promise.reject(new Error('النموذج غير محمّل بعد')))
      const output = await transcriber(msg.audio, {
        language: 'arabic',
        task: 'transcribe',
        chunk_length_s: 30,
      })
      const text = Array.isArray(output) ? output.map((o) => o.text).join(' ') : output.text
      self.postMessage({ type: 'result', text, requestId: msg.requestId })
    } catch (err) {
      self.postMessage({ type: 'error', error: (err as Error).message, requestId: msg.requestId })
    }
  }
}
