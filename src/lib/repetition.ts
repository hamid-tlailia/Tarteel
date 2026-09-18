import type { TimedChunk } from '../asr/whisper.worker'

const MAX_RUN = 2

/**
 * Collapses runs of 3+ consecutive identical (normalized) recognized words down to at
 * most 2 — a defensive guard against ASR hallucination loops (repeating one filler word
 * over and over, typically across a silent stretch). Real recitation essentially never
 * repeats the exact same single word more than twice in a row. Keeps `raw`, `normalized`
 * and `chunks` in lockstep so word-level timestamps still line up by index afterwards.
 */
export function collapseRepeatedWords(
  raw: string[],
  normalized: string[],
  chunks: TimedChunk[],
): { raw: string[]; normalized: string[]; chunks: TimedChunk[] } {
  const hasChunks = chunks.length === normalized.length
  const outRaw: string[] = []
  const outNormalized: string[] = []
  const outChunks: TimedChunk[] = []

  let i = 0
  while (i < normalized.length) {
    let j = i
    while (j < normalized.length && normalized[j] === normalized[i]) j++
    const runLength = j - i
    const keep = normalized[i] === '' ? runLength : Math.min(runLength, MAX_RUN)
    for (let k = 0; k < keep; k++) {
      outRaw.push(raw[i + k])
      outNormalized.push(normalized[i + k])
      if (hasChunks) outChunks.push(chunks[i + k])
    }
    i = j
  }

  return { raw: outRaw, normalized: outNormalized, chunks: hasChunks ? outChunks : chunks }
}
