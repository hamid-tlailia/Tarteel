/** A cross-attention tensor as the ONNX runtime returns it: flat data plus its shape. */
export interface AttentionTensor {
  data: ArrayLike<number>
  dims: readonly number[]
}

/**
 * Word timings from cross-attention, for checkpoints that ship no `alignment_heads` list.
 *
 * Two things make this harder than reading off the strongest-attended frame per token.
 * Whisper's cross-attention has a pronounced sink on the first encoder frame — a large
 * share of every token's attention lands there regardless of when the token was actually
 * spoken — so a plain argmax pins nearly every token to time zero, which is exactly what
 * the first attempt did (the diagnostics showed a measured duration of 0 for almost every
 * word). And attention is noisy enough per token that a greedy walk wanders.
 *
 * So the map is normalized first — each frame's column has its mean across tokens removed,
 * which is what kills the sink, and each token's row is then standardized — and the path
 * through it is found with dynamic time warping rather than greedily, so the alignment is
 * globally consistent and monotonic by construction.
 */
export function timingsFromAveragedAttention(
  layers: AttentionTensor[],
  wordSpans: [number, number][],
  initLength: number,
  decoderLength: number,
  maxEncoderFrame: number,
  timePrecision: number,
): ([number, number] | null)[] | null {
  const dims = layers[0]?.dims
  if (!dims || dims.length < 2) return null
  const encoderPositions = dims[dims.length - 1]
  const decoderPositions = dims[dims.length - 2]
  if (decoderPositions !== decoderLength || encoderPositions <= 0) return null

  // Only the frames the audio actually occupies; the encoder always pads out to 30 seconds.
  const frames = Math.max(1, Math.min(encoderPositions, maxEncoderFrame || encoderPositions))
  // Only the target tokens matter — the init tokens (start-of-transcript, language, task)
  // correspond to no audio at all and would just distort the path.
  const firstToken = Math.max(0, initLength - 1)
  const tokens = decoderPositions - firstToken
  if (tokens <= 0) return null

  const attention = new Float64Array(tokens * frames)
  let heads = 0
  for (const layer of layers) {
    const data = layer.data
    const headsHere = Math.max(1, Math.floor(data.length / (decoderPositions * encoderPositions)))
    for (let h = 0; h < headsHere; h++) {
      const base = h * decoderPositions * encoderPositions
      for (let t = 0; t < tokens; t++) {
        const src = base + (firstToken + t) * encoderPositions
        const dst = t * frames
        for (let s = 0; s < frames; s++) attention[dst + s] += data[src + s]
      }
      heads++
    }
  }
  if (heads === 0) return null

  // Remove each frame's baseline pull across all tokens — this is what defeats the sink.
  for (let s = 0; s < frames; s++) {
    let sum = 0
    for (let t = 0; t < tokens; t++) sum += attention[t * frames + s]
    const mean = sum / tokens
    for (let t = 0; t < tokens; t++) attention[t * frames + s] -= mean
  }
  // Standardize each token's row so no single token dominates the path cost.
  for (let t = 0; t < tokens; t++) {
    const row = t * frames
    let sum = 0
    for (let s = 0; s < frames; s++) sum += attention[row + s]
    const mean = sum / frames
    let variance = 0
    for (let s = 0; s < frames; s++) {
      const d = attention[row + s] - mean
      variance += d * d
    }
    const sd = Math.sqrt(variance / frames) || 1
    for (let s = 0; s < frames; s++) attention[row + s] = (attention[row + s] - mean) / sd
  }

  // Dynamic time warping over the negated attention: the cheapest monotonic path through
  // the map is the alignment of tokens to audio frames.
  const cost = new Float64Array(tokens * frames).fill(Infinity)
  const from = new Uint8Array(tokens * frames) // 0 = diagonal, 1 = previous token, 2 = previous frame
  cost[0] = -attention[0]
  for (let t = 0; t < tokens; t++) {
    for (let s = 0; s < frames; s++) {
      if (t === 0 && s === 0) continue
      const here = -attention[t * frames + s]
      let best = Infinity
      let choice = 0
      if (t > 0 && s > 0) {
        best = cost[(t - 1) * frames + (s - 1)]
        choice = 0
      }
      if (t > 0 && cost[(t - 1) * frames + s] < best) {
        best = cost[(t - 1) * frames + s]
        choice = 1
      }
      if (s > 0 && cost[t * frames + (s - 1)] < best) {
        best = cost[t * frames + (s - 1)]
        choice = 2
      }
      cost[t * frames + s] = best + here
      from[t * frames + s] = choice
    }
  }

  // Walk the path back, recording the first and last frame each token occupies.
  const firstFrame = new Int32Array(tokens).fill(-1)
  const lastFrame = new Int32Array(tokens).fill(-1)
  let t = tokens - 1
  let s = frames - 1
  while (t >= 0 && s >= 0) {
    if (lastFrame[t] === -1) lastFrame[t] = s
    firstFrame[t] = s
    if (t === 0 && s === 0) break
    const step = from[t * frames + s]
    if (step === 0) {
      t--
      s--
    } else if (step === 1) {
      t--
    } else {
      s--
    }
  }

  const startOf = (tokenIndex: number) =>
    tokenIndex >= 0 && tokenIndex < tokens && firstFrame[tokenIndex] >= 0
      ? firstFrame[tokenIndex] * timePrecision
      : null
  const endOf = (tokenIndex: number) =>
    tokenIndex >= 0 && tokenIndex < tokens && lastFrame[tokenIndex] >= 0
      ? (lastFrame[tokenIndex] + 1) * timePrecision
      : null

  return wordSpans.map(([spanStart, spanEnd]) => {
    // Token i of the target sequence sits at decoder position initLength + i, which is
    // index (initLength + i) - firstToken in the trimmed matrix.
    const offset = initLength - firstToken
    const startTime = startOf(offset + spanStart)
    const endTime = endOf(offset + spanEnd - 1)
    if (startTime === null || endTime === null) return null
    return [startTime, Math.max(endTime, startTime)]
  })
}
