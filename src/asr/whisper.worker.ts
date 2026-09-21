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

export interface ForcedAlignmentResult {
  /** One confidence score (0–1) per reference word — see scoreAndAlignReferenceWords. */
  confidences: number[]
  /** One [start, end] time in seconds per reference word, or null where cross-attention
   * extraction wasn't available/successful for that word. Null entirely if this export
   * doesn't support cross-attention output at all. */
  wordTimings: ([number, number] | null)[] | null
}

/** Pulls the per-layer cross-attention tensors out of a raw model output object. ONNX
 * decoder exports that include them name the outputs like `cross_attentions.0`,
 * `cross_attentions.1`, ... (one per decoder layer) — sorted by that trailing index so the
 * layer order is correct regardless of raw object key iteration order. */
function getCrossAttentionLayers(modelOutput: Record<string, Tensor>): Tensor[] | null {
  const entries = Object.keys(modelOutput)
    .filter((k) => k.startsWith('cross_attentions'))
    .map((k) => {
      const match = k.match(/(\d+)$/)
      return { key: k, layer: match ? Number(match[1]) : 0 }
    })
    .sort((a, b) => a.layer - b.layer)
  if (entries.length === 0) return null
  return entries.map((e) => modelOutput[e.key])
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
async function scoreAndAlignReferenceWords(
  transcriber: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array,
  referenceWords: string[],
): Promise<ForcedAlignmentResult> {
  if (referenceWords.length === 0) return { confidences: [], wordTimings: [] }

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
  const confidences = wordSpans.map(([start, end]) => {
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

  // Best-effort word timing from the *same* forced pass, via the same cross-attention +
  // dynamic-time-warping technique transformers.js itself uses for `return_timestamps:
  // 'word'` — except here it's applied against the known/forced sequence instead of a
  // freely generated one, so the timing lines up with the reference word actually being
  // checked rather than whatever the free decode guessed in its place. `_extract_token_
  // timestamps` expects the "one array of layer-tensors per generation step" shape that
  // generate()'s autoregressive loop produces; our single non-autoregressive forward pass
  // already covers the whole sequence in one go, so we simply wrap it as if it were one
  // step containing every position.
  let wordTimings: ([number, number] | null)[] | null = null
  try {
    const crossAttentionLayers = getCrossAttentionLayers(output)
    const alignmentHeads = generationConfig.alignment_heads
    const featureExtractor = processor.feature_extractor
    if (crossAttentionLayers && alignmentHeads && featureExtractor) {
      const featureExtractorConfig = featureExtractor.config as { hop_length: number; chunk_length: number }
      const maxSourcePositions = (model.config as unknown as { max_source_positions: number }).max_source_positions
      const numFrames = Math.floor(audio.length / featureExtractorConfig.hop_length)
      const timePrecision = featureExtractorConfig.chunk_length / maxSourcePositions

      const tokenTimestamps = model._extract_token_timestamps(
        { cross_attentions: [crossAttentionLayers], sequences: decoder_input_ids },
        alignmentHeads,
        numFrames,
        timePrecision,
        initLength,
      )
      const ts = tokenTimestamps.data as Float32Array
      const at = (idx: number) => (idx >= 0 && idx < ts.length ? ts[idx] : null)

      wordTimings = wordSpans.map(([start, end]) => {
        const startTime = at(initLength + start)
        const endTime = at(initLength + end) ?? at(ts.length - 1)
        if (startTime === null || endTime === null) return null
        return [startTime, Math.max(endTime, startTime)]
      })
    }
  } catch {
    wordTimings = null
  }

  return { confidences, wordTimings }
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
      // no longer the source of truth for correctness (see scoreAndAlignReferenceWords below).
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

      // Forced-decoding confidence + timing is the important new signal. If this model's
      // ONNX export doesn't support a plain (non-generate) forward call the way we expect,
      // fail soft: the caller falls back to text-match correctness like before.
      let wordConfidences: number[] | null = null
      let wordTimings: ([number, number] | null)[] | null = null
      try {
        const forced = await scoreAndAlignReferenceWords(transcriber, msg.audio, msg.referenceWords)
        wordConfidences = forced.confidences
        wordTimings = forced.wordTimings
      } catch {
        wordConfidences = null
        wordTimings = null
      }

      self.postMessage({ type: 'result', text: result.text, chunks, wordConfidences, wordTimings, requestId: msg.requestId })
    } catch (err) {
      self.postMessage({ type: 'error', error: (err as Error).message, requestId: msg.requestId })
    }
  }
}
