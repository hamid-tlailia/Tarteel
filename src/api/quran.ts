import { applyDerivedRuleSpans, parseTajweedMarkup } from '../lib/tajweed'
import type { Ayah, SurahMeta, TajweedRuleId } from '../types/quran'
import { DEFAULT_RECITER_ID } from '../lib/reciters'

const BASE = 'https://api.alquran.cloud/v1'
const AUDIO_CDN = 'https://cdn.islamic.network/quran/audio/128'

/**
 * The reciter whose recording is played back and used as the timing reference.
 *
 * Module-level rather than passed through every call because it is a setting, not a
 * parameter of any one request — and because the ayah objects are cached, so changing it has
 * to invalidate that cache rather than quietly serve the previous reciter's URLs.
 */
const surahCache = new Map<number, Ayah[]>()

let reciterId = DEFAULT_RECITER_ID

export function setReciter(id: string): void {
  if (id === reciterId) return
  reciterId = id
  surahCache.clear()
}

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
    segments: applyDerivedRuleSpans(parseTajweedMarkup(a.text)),
    audioUrl: `${AUDIO_CDN}/${reciterId}/${a.number}.mp3`,
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
  return `${AUDIO_CDN}/${reciterId}/${surahNumber}.mp3`
}

/**
 * A worked example, verified against the live text, for each rule the lessons teach.
 *
 * Two of the derived rules have no example anywhere in the surahs scanned below. The madd
 * al-līn needs a stop on a word ending in a sākin wāw or yāʾ after a fatḥa — Sūrat Quraysh
 * is the textbook case and is four ayahs long. The rāʾ with two permitted readings is rarer
 * still: «فِرْقٍ» (26:63), where the kasra before it and the heavy qāf after it pull opposite
 * ways. Without these, opening either lesson showed no example at all.
 *
 * Naming the ayah also spares the reader a search. Looking for idghām al-mutajānisayn used to
 * mean downloading Sūrat al-Baqarah's 286 ayahs and testing every one; «ٱرْكَب مَّعَنَا» is in
 * Sūrat Hūd and is the example every primer uses anyway.
 *
 * Nothing here is trusted blindly: an ayah is only offered once the parsed text is confirmed
 * to contain the rule, so an entry that stops being right is skipped rather than shown, and
 * the scan below still runs to fill the rest.
 */
const RULE_EXAMPLE_AYAHS: Partial<Record<TajweedRuleId, [number, number][]>> = {
  madda_leen: [
    [106, 1], // قُرَيْشٍ
    [106, 2], // ٱلصَّيْفِ
    [106, 4], // خَوْفٍۭ
  ],
  ra_wajhan: [
    [26, 63], // فِرْقٍ
  ],
  idgham_mutajanisayn: [
    [11, 42], // ٱرْكَب مَّعَنَا
  ],
  madda_sila_kubra: [
    [104, 3], // مَالَهُۥٓ أَخْلَدَهُۥ
  ],
  madda_badal: [
    [2, 9], // ءَامَنُوا۟
  ],
  madda_necessary: [
    [1, 7], // ٱلضَّآلِّينَ
  ],
  madda_iwad: [
    [73, 4], // تَرْتِيلًا
  ],
  lam_jalalah_mufakhkhama: [
    [112, 1], // قُلْ هُوَ ٱللَّهُ
  ],
  lam_jalalah_muraqqaqa: [
    [1, 1], // بِسْمِ ٱللَّهِ
  ],
  madda_permissible: [
    [36, 56], // the jāʾiz that is neither an ʿāriḍ nor a līn
  ],
}

/** Surahs with a good density/variety of tajweed rules, used to find live worked examples.
 * 77 (نَخْلُقكُّمْ 77:20) covers idghām al-mutaqāribayn and 7 (أَثْقَلَت دَّعَوَا 7:189) /
 * 11 (ٱرْكَب مَّعَنَا 11:42) cover idghām al-mutajānisayn — the two rarest marked rules. */
const EXAMPLE_SURAHS = [67, 36, 78, 77, 2, 112, 113, 114, 1, 7, 11]

/** Live ayahs illustrating a given tajweed rule: the known examples first, then a scan. */
export async function fetchExampleAyahsForRule(ruleId: TajweedRuleId, limit = 3): Promise<Ayah[]> {
  const found: Ayah[] = []
  const taken = new Set<number>()
  const take = (ayah: Ayah) => {
    if (taken.has(ayah.number)) return
    if (!ayah.segments.some((s) => s.rule === ruleId)) return
    taken.add(ayah.number)
    found.push(ayah)
  }

  for (const [surahNumber, numberInSurah] of RULE_EXAMPLE_AYAHS[ruleId] ?? []) {
    if (found.length >= limit) break
    try {
      take(await fetchAyah(surahNumber, numberInSurah))
    } catch {
      // A named example that cannot be fetched or no longer carries the rule is simply
      // skipped — the scan below is still there to find another.
    }
  }

  for (const surahNumber of EXAMPLE_SURAHS) {
    if (found.length >= limit) break
    for (const ayah of await fetchSurahAyahs(surahNumber)) {
      take(ayah)
      if (found.length >= limit) break
    }
  }
  return found
}
