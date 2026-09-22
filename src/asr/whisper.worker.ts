/// <reference lib="webworker" />
import {
  pipeline,
  env,
  Tensor,
  type AutomaticSpeechRecognitionPipeline,
  type WhisperForConditionalGeneration,
} from '@huggingface/transformers'
import { applyVariant, ORTHOGRAPHY_VARIANTS, type OrthographyVariant } from '../lib/orthography'
import { timingsFromAveragedAttention, type AttentionTensor } from '../lib/attentionAlignment'

env.allowLocalModels = false

/**
 * The onnxruntime-web version @huggingface/transformers itself depends on can be an
 * unpinned nightly "dev" build rather than a stable npm release (verified for this project:
 * it resolved to `1.31.0-dev.<date>-<hash>`, npm's `dev` dist-tag — not `latest`, which is
 * `1.30.0`). By default transformers.js fetches its WASM runtime from a CDN URL built from
 * that *exact* resolved version string, so the app ends up depending on a same-day nightly
 * artifact that can vanish from the registry or carry undiagnosed bugs — a documented one
 * being an int64→Number (BigInt) defect that broke Whisper specifically on mobile browsers,
 * root-caused in a sibling project (hamid-tlailia/Tajweed) that hit the exact same failure
 * mode we did. Pin explicitly to the latest stable release instead, with a backup CDN for
 * flaky mobile networks.
 */
const ORT_STABLE_VERSION = '1.30.0'
const ORT_WASM_PREFIXES = [
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_STABLE_VERSION}/dist/`,
  `https://unpkg.com/onnxruntime-web@${ORT_STABLE_VERSION}/dist/`,
]
/** A mean per-word confidence at or above this means the spelling is plainly the right one,
 * so there is no point paying for another forward pass to check the remaining variants. */
const CONFIDENT_ENOUGH_TO_STOP = 0.15

function ortWasmPathsFor(prefix: string) {
  return {
    mjs: `${prefix}ort-wasm-simd-threaded.asyncify.mjs`,
    wasm: `${prefix}ort-wasm-simd-threaded.asyncify.wasm`,
  }
}

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
  /** Which spelling of the reference the model was asked to justify — see orthography.ts. */
  variant: OrthographyVariant
  /** Mean confidence over all words, used to choose between spellings. */
  meanConfidence: number
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
  variant: OrthographyVariant,
): Promise<ForcedAlignmentResult> {
  if (referenceWords.length === 0) return { confidences: [], wordTimings: [], variant, meanConfidence: 0 }

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
    const spelled = applyVariant(word, variant)
    const ids: number[] = tokenizer.encode(' ' + spelled, { add_special_tokens: false })
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

  /** log P(token at `seqPos+1` = `tokenId`), computed stably as logit − logsumexp(logits)
   * so we never materialise a ~51k-entry probability array per token. */
  function tokenLogProb(seqPos: number, tokenId: number): number {
    const row = data.subarray(seqPos * vocabSize, (seqPos + 1) * vocabSize)
    let max = -Infinity
    for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i]
    let sumExp = 0
    for (let i = 0; i < row.length; i++) sumExp += Math.exp(row[i] - max)
    const logZ = max + Math.log(sumExp)
    return (row[tokenId] ?? -Infinity) - logZ
  }

  // Per-word confidence is the GEOMETRIC MEAN of its tokens' probabilities (i.e. exp of the
  // mean log-prob), the standard way to score a forced-decoded span.
  //
  // This used to take the *minimum* token probability instead, which was catastrophically
  // wrong: Arabic words split into 3–6 BPE tokens in Whisper's multilingual vocabulary, and
  // a correctly recited word routinely still has one sub-token the model is unsure about
  // (it spreads probability across plausible spellings). The minimum therefore sat below
  // any usable threshold for nearly *every* word, so a perfectly recited ayah scored 0%.
  // The geometric mean judges the word as a whole, so one hesitant sub-token no longer
  // condemns it while a genuinely unrecited word — where *every* token is improbable —
  // still scores near zero.
  const confidences = wordSpans.map(([start, end]) => {
    if (end <= start) return 0
    let sumLogP = 0
    for (let t = start; t < end; t++) {
      sumLogP += tokenLogProb(initLength + t - 1, targetTokens[t])
    }
    const geometricMean = Math.exp(sumLogP / (end - start))
    return Number.isFinite(geometricMean) ? geometricMean : 0
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
  const crossAttentionLayers = getCrossAttentionLayers(output)
  const featureExtractor = processor.feature_extractor
  if (crossAttentionLayers && featureExtractor) {
    const featureExtractorConfig = featureExtractor.config as { hop_length: number; chunk_length: number }
    const maxSourcePositions = (model.config as unknown as { max_source_positions: number }).max_source_positions
    const numFrames = Math.floor(audio.length / featureExtractorConfig.hop_length)
    const timePrecision = featureExtractorConfig.chunk_length / maxSourcePositions

    try {
      const alignmentHeads = generationConfig.alignment_heads
      if (!alignmentHeads) throw new Error('no alignment heads on this checkpoint')
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
    } catch {
      // `alignment_heads` is a curated per-checkpoint list of the attention heads that track
      // audio position, and community ONNX conversions frequently ship without it — in which
      // case the call above throws and, until now, every word silently came back with no
      // timing at all, leaving the madd and qalqalah checks nothing to measure. Averaging
      // every head is cruder than using the curated ones, but it needs no such list and is
      // far better than no timing at all.
      wordTimings = timingsFromAveragedAttention(
        crossAttentionLayers as unknown as AttentionTensor[],
        wordSpans,
        initLength,
        decoderInputIdList.length,
        Math.floor(numFrames / 2), // encoder positions cover two mel frames each
        timePrecision,
      )
    }
  }

  const meanConfidence =
    confidences.length > 0 ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length : 0

  return { confidences, wordTimings, variant, meanConfidence }
}

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data
  if (msg.type === 'load') {
    try {
      transcriberPromise ??= (async () => {
        let lastErr: unknown = null
        for (const prefix of ORT_WASM_PREFIXES) {
          try {
            if (!env.backends.onnx.wasm) throw new Error('ONNX wasm backend unavailable')
            env.backends.onnx.wasm.wasmPaths = ortWasmPathsFor(prefix)
            return (await pipeline('automatic-speech-recognition', MODEL_ID, {
              dtype: 'q8',
              progress_callback: (progress: ProgressInfo) => {
                self.postMessage({ type: 'progress', progress })
              },
            })) as AutomaticSpeechRecognitionPipeline
          } catch (err) {
            lastErr = err // try the next CDN
          }
        }
        throw lastErr instanceof Error ? lastErr : new Error('تعذّر تحميل محرك التعرّف الصوتي (ONNX Runtime)')
      })()
      await transcriberPromise
      self.postMessage({ type: 'ready' })
    } catch (err) {
      // Reset so the "إعادة المحاولة" button actually retries instead of re-awaiting the
      // same cached rejected promise forever.
      transcriberPromise = null
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
      // Which spelling of the reference this checkpoint finds probable is a property of the
      // transcripts it was fine-tuned on, which we cannot know up front — so try them and
      // keep the best, stopping as soon as one scores well enough to be obviously right.
      // Each attempt is a single non-autoregressive forward pass.
      let best: ForcedAlignmentResult | null = null
      for (const variant of ORTHOGRAPHY_VARIANTS) {
        try {
          const attempt = await scoreAndAlignReferenceWords(transcriber, msg.audio, msg.referenceWords, variant)
          if (!best || attempt.meanConfidence > best.meanConfidence) best = attempt
          if (attempt.meanConfidence >= CONFIDENT_ENOUGH_TO_STOP) break
        } catch {
          // This export may not support a plain forward call at all; fail soft and let the
          // caller fall back to text-match correctness.
        }
      }

      self.postMessage({
        type: 'result',
        text: result.text,
        chunks,
        wordConfidences: best?.confidences ?? null,
        wordTimings: best?.wordTimings ?? null,
        orthographyVariant: best?.variant ?? null,
        requestId: msg.requestId,
      })
    } catch (err) {
      self.postMessage({ type: 'error', error: (err as Error).message, requestId: msg.requestId })
    }
  }
}
