import { parseTajweedMarkup } from '../lib/tajweed'
import type { Ayah, SurahMeta } from '../types/quran'

const BASE = 'https://api.alquran.cloud/v1'
const RECITER = 'ar.alafasy'
const AUDIO_CDN = 'https://cdn.islamic.network/quran/audio/128'

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`فشل الاتصال بواجهة القرآن: ${res.status}`)
  const json = await res.json()
  if (json.code !== 200) throw new Error(json.status ?? 'استجابة غير متوقعة')
  return json.data as T
}

let surahListCache: SurahMeta[] | null = null

export async function fetchSurahList(): Promise<SurahMeta[]> {
  if (surahListCache) return surahListCache
  const data = await getJson<SurahMeta[]>(`${BASE}/surah`)
  surahListCache = data
  return data
}

const surahCache = new Map<number, Ayah[]>()

/** Fetches one surah's ayahs with tashkeel + parsed tajweed coloring + reciter audio. */
export async function fetchSurahAyahs(surahNumber: number): Promise<Ayah[]> {
  const cached = surahCache.get(surahNumber)
  if (cached) return cached

  const data = await getJson<{ ayahs: Array<{ number: number; numberInSurah: number; text: string }> }>(
    `${BASE}/surah/${surahNumber}/quran-tajweed`,
  )

  const ayahs: Ayah[] = data.ayahs.map((a) => ({
    number: a.number,
    numberInSurah: a.numberInSurah,
    surah: surahNumber,
    text: a.text,
    segments: parseTajweedMarkup(a.text),
    audioUrl: `${AUDIO_CDN}/${RECITER}/${a.number}.mp3`,
  }))

  surahCache.set(surahNumber, ayahs)
  return ayahs
}

export async function fetchAyah(surahNumber: number, ayahInSurah: number): Promise<Ayah> {
  const ayahs = await fetchSurahAyahs(surahNumber)
  const ayah = ayahs.find((a) => a.numberInSurah === ayahInSurah)
  if (!ayah) throw new Error('لم يتم العثور على الآية')
  return ayah
}

export function surahAudioUrl(surahNumber: number): string {
  return `${AUDIO_CDN}/${RECITER}/${surahNumber}.mp3`
}

/** Surahs with a good density/variety of tajweed rules, used to find live worked examples. */
const EXAMPLE_SURAHS = [67, 36, 78, 2, 112, 113, 114, 1]

/** Scans a handful of surahs for live ayahs illustrating a given tajweed rule. */
export async function fetchExampleAyahsForRule(
  ruleId: import('../types/quran').TajweedRuleId,
  limit = 3,
): Promise<Ayah[]> {
  const found: Ayah[] = []
  for (const surahNumber of EXAMPLE_SURAHS) {
    if (found.length >= limit) break
    const ayahs = await fetchSurahAyahs(surahNumber)
    for (const ayah of ayahs) {
      if (ayah.segments.some((s) => s.rule === ruleId)) {
        found.push(ayah)
        if (found.length >= limit) break
      }
    }
  }
  return found
}
