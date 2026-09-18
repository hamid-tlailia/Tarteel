/// <reference lib="webworker" />
import {
  pipeline,
  env,
  softmax,
  Tensor,
  type AutomaticSpeechRecognitionPipeline,
  type WhisperForConditionalGeneration,
} from '@huggingface/transformers'

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
  | { type: 'transcribe'; audio: Float32Array; referenceWords: string[]; requestId: number }

type ProgressInfo = { status: string; file?: string; progress?: number; loaded?: number; total?: number }
export interface TimedChunk {
  text: string
  timestamp: [number, number | null]
}

/**
 * Scores each *known* reference word against the audio via forced decoding (teacher
 * forcing) instead of asking Whisper to freely guess what was said.
 *
 * Free transcription picks the most *statistically likely* phrase given everything the
 * model saw in training — for a short, context-poor utterance that bias can win over the
 * truth (e.g. "الحاقة" recognized as "الحم", because the disjointed letters "حم" open
 * seven different surahs and are far more common in training data than "الحاقة" said in
 * isolation). Forced decoding sidesteps that entirely: we don't ask "what did you hear?",
 * we ask "how well does this audio match *this exact* word?" by feeding the known word's
 * tokens as the decoder input and reading off the model's own predicted probability for
 * each of them. A word that was actually recited gets high probability; a dropped,
 * mismatched, or silent one gets low probability — regardless of what a free decode would
 * have guessed instead.
 *
 * Returns one confidence score (0–1, the *minimum* per-token probability in the word) per
 * entry in `referenceWords`, or throws if this model's export doesn't support a plain
 * forward pass the way expected — callers should fall back to text-match comparison.
 */
async function scoreReferenceWords(
  transcriber: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array,
  referenceWords: string[],
): Promise<number[]> {
  if (referenceWords.length === 0) return []

  const model = transcriber.model as WhisperForConditionalGeneration
  const tokenizer = transcriber.tokenizer
  const processor = transcriber.processor

  // Relies on WhisperForConditionalGeneration's own init-token logic (same one `generate()`
  // uses internally) so the forced prompt exactly matches a real transcription prompt.
  const generationConfig = model._prepare_generation_config(null, { language: 'arabic', task: 'transcribe' })
  const initTokens: number[] = model._retrieve_init_tokens(generationConfig)

  const wordSpans: [number, number][] = []
  const targetTokens: number[] = []
  for (const word of referenceWords) {
    const ids: number[] = tokenizer.encode(' ' + word, { add_special_tokens: false })
    wordSpans.push([targetTokens.length, targetTokens.length + ids.length])
    targetTokens.push(...ids)
  }

  const { input_features } = await processor(audio)
  const decoderInputIdList = [...initTokens, ...targetTokens]
  const decoder_input_ids = new Tensor(
    'int64',
    BigInt64Array.from(decoderInputIdList.map((x) => BigInt(x))),
    [1, decoderInputIdList.length],
  )

  const output = await model({ input_features, decoder_input_ids })
  const logits = output.logits
  const vocabSize = logits.dims[2]
  const data = logits.data as Float32Array

  const initLength = initTokens.length
  return wordSpans.map(([start, end]) => {
    let minProb = 1
    for (let t = start; t < end; t++) {
      const seqPos = initLength + t - 1 // logits at seqPos predict the token at seqPos+1
      const row = data.subarray(seqPos * vocabSize, (seqPos + 1) * vocabSize)
      const probs = softmax(Array.from(row))
      const p = probs[targetTokens[t]] ?? 0
      if (p < minProb) minProb = p
    }
    return minProb
  })
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

      // Free decode: used for approximate word timing (madd-duration checks), rough
      // "how far has the reciter gotten" progress, and a human-readable hypothesis text —
      // no longer the source of truth for correctness (see scoreReferenceWords above).
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

      // Forced-decoding confidence is the important new signal. If this model's ONNX
      // export doesn't support a plain (non-generate) forward call the way we expect,
      // fail soft: the caller falls back to text-match correctness like before.
      let wordConfidences: number[] | null = null
      try {
        wordConfidences = await scoreReferenceWords(transcriber, msg.audio, msg.referenceWords)
      } catch {
        wordConfidences = null
      }

      self.postMessage({ type: 'result', text: result.text, chunks, wordConfidences, requestId: msg.requestId })
    } catch (err) {
      self.postMessage({ type: 'error', error: (err as Error).message, requestId: msg.requestId })
    }
  }
}
