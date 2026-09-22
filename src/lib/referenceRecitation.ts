import type { Ayah } from '../types/quran'
import { segmentsToWords } from './tajweed'
import type { ReferenceTiming } from './referenceTiming'
import { reciterOf } from './reciters'

/**
 * Turning an accredited reciter's published recording into the timings the checks compare
 * against.
 *
 * Each ayah is fetched, decoded and put through the *same* forced-alignment pass the
 * learner's own recording goes through — the text is already known, so only the alignment
 * half runs. The per-word timings are then concatenated across the passage. Only durations
 * are ever read from them, so the fact that each ayah's clock restarts at zero does not
 * matter.
 *
 * Every part of this is allowed to fail. The reciter's CDN may be unreachable, the model may
 * not be loaded yet, alignment may return nothing for a word. Each failure degrades to no
 * reference, and the checks fall back to the theoretical durations exactly as before — this
 * is evidence that improves the judgement when present, never a dependency.
 */

/** Alignments already computed this session, keyed by reciter and ayah. Recomputing one is
 * a network fetch plus a model pass, and a learner repeating a passage is the normal case. */
const cache = new Map<string, ([number, number] | null)[] | null>()

export type AlignFn = (audio: Float32Array, referenceWords: string[]) => Promise<([number, number] | null)[] | null>
export type DecodeFn = (blob: Blob) => Promise<Float32Array>

export interface BuildReferenceOptions {
  reciterId: string
  ayahs: Ayah[]
  align: AlignFn
  decode: DecodeFn
  /** Swappable for tests. */
  fetchAudio?: (url: string) => Promise<Blob>
  /** Abandoned work when the learner changes passage mid-fetch. */
  signal?: AbortSignal
}

/**
 * everyayah.com, not the CDN the app plays from.
 *
 * Reading a recording's samples is a cross-origin fetch, and the Islamic Network CDN sends
 * no Access-Control-Allow-Origin header at all — so every one of these fetches failed in the
 * browser and the app reported that no reference was available, for every reciter, always.
 * everyayah serves the same recitations with `Access-Control-Allow-Origin: *`. Playback is
 * unaffected: an <audio> element needs no such permission and still uses the original CDN.
 *
 * Its paths are surah and ayah, each padded to three digits, rather than a running ayah
 * number.
 */
const ANALYSIS_CDN = 'https://everyayah.com/data'

function analysisUrlFor(reciterId: string, ayah: Ayah): string | null {
  const folder = reciterOf(reciterId).analysisFolder
  if (!folder) return null
  const pad = (n: number) => String(n).padStart(3, '0')
  return `${ANALYSIS_CDN}/${folder}/${pad(ayah.surah)}${pad(ayah.numberInSurah)}.mp3`
}

async function defaultFetchAudio(url: string): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`reference audio ${res.status}`)
  return res.blob()
}

/**
 * Aligns the reciter's recording of this passage. Returns null when no ayah could be
 * aligned, so callers can treat "no reference" as one condition rather than many.
 */
export async function buildReferenceTiming({
  reciterId,
  ayahs,
  align,
  decode,
  fetchAudio = defaultFetchAudio,
  signal,
}: BuildReferenceOptions): Promise<ReferenceTiming | null> {
  const wordTimings: ([number, number] | null)[] = []
  let alignedAny = false

  for (const ayah of ayahs) {
    if (signal?.aborted) return null
    const words = segmentsToWords(ayah.segments)
    const key = `${reciterId}:${ayah.number}`

    let timings = cache.get(key)
    if (timings === undefined) {
      const url = analysisUrlFor(reciterId, ayah)
      try {
        if (!url) throw new Error('this reciter has no source that permits reading its samples')
        const blob = await fetchAudio(url)
        if (signal?.aborted) return null
        const pcm = await decode(blob)
        timings = await align(pcm, words.map((w) => w.word))
      } catch {
        timings = null
      }
      // A null is cached too: a reciter whose audio is missing should not be re-fetched on
      // every recording attempt.
      cache.set(key, timings ?? null)
    }

    if (timings && timings.length === words.length) {
      alignedAny = true
      wordTimings.push(...timings)
    } else {
      // Keep the array aligned with the passage's words even where this ayah gave nothing,
      // since the comparison indexes into it by word position.
      wordTimings.push(...words.map(() => null))
    }
  }

  return alignedAny ? { reciterId, wordTimings } : null
}

/** Forgets what has been aligned — used when a test needs a clean slate. */
export function clearReferenceCache(): void {
  cache.clear()
}
