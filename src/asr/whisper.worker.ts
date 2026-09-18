/// <reference lib="webworker" />
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

env.allowLocalModels = false

// A generic Whisper model has essentially no idea what Quranic recitation sounds like
// (it's melodic/elongated speech very unlike what Whisper's Arabic training data covers),
// which is why it can output something as unrelated as "نحن أخذ" for "لا أقسم بهذا البلد".
// This is an ONNX export (community-converted, not an official onnx-community/Xenova
// release) of tarteel-ai/whisper-base-ar-quran — the same architecture, fine-tuned on
// actual Quran recitation audio. If it turns out to perform worse in practice, revert
// this to 'onnx-community/whisper-base'.
const MODEL_ID = 'An0xity/whisper-base-ar-quran-onnx-timestamped'

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null

type IncomingMessage =
  | { type: 'load' }
  | { type: 'transcribe'; audio: Float32Array; requestId: number }

type ProgressInfo = { status: string; file?: string; progress?: number; loaded?: number; total?: number }
export interface TimedChunk {
  text: string
  timestamp: [number, number | null]
}

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

      // `repetition_penalty`/`no_repeat_ngram_size` discourage the classic small-Whisper
      // failure mode of looping on one hallucinated word over a silent stretch — the main
      // symptom reported in practice (e.g. dozens of "نحن" appearing from nowhere).
      const baseOptions = {
        language: 'arabic',
        task: 'transcribe',
        chunk_length_s: 30,
        repetition_penalty: 1.3,
        no_repeat_ngram_size: 3,
      } as const

      // Word-level timestamps power the acoustic (madd-duration) checks, but not every
      // exported model/build supports `return_timestamps: 'word'` — fall back gracefully
      // to plain transcription (text-only comparison still works) if it throws.
      let output
      let hasTimestamps = true
      try {
        output = await transcriber(msg.audio, { ...baseOptions, return_timestamps: 'word' })
      } catch {
        hasTimestamps = false
        output = await transcriber(msg.audio, baseOptions)
      }

      const result = Array.isArray(output) ? output[0] : output
      const chunks: TimedChunk[] = hasTimestamps && Array.isArray(result?.chunks) ? result.chunks : []
      self.postMessage({ type: 'result', text: result.text, chunks, requestId: msg.requestId })
    } catch (err) {
      self.postMessage({ type: 'error', error: (err as Error).message, requestId: msg.requestId })
    }
  }
}
