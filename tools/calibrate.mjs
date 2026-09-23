#!/usr/bin/env node
/**
 * Measures the app's timing model against published recitations of accredited reciters.
 *
 *   node tools/calibrate.mjs                      # a default set of surahs and reciters
 *   node tools/calibrate.mjs --surahs 1,78,112 --reciters 6,7 --json
 *
 * Two sources, both open:
 *   · api.alquran.cloud  — the muṣḥaf text with the edition's tajweed markup, so this build's
 *     own engine decides which rulings each word carries;
 *   · api.qurancdn.com   — word-level timings (`segments`) for each reciter, with the qirāʾa
 *     named, so only Ḥafṣ readings are used.
 *
 * Why it can say anything at all without a teacher: every word of an accredited reciter's
 * published recitation is a labelled-correct example. So the faults this app raises against
 * them are false alarms by construction, and the false-alarm rate — the error that costs a
 * learner's trust — is measurable today. What no amount of correct recitation can measure is
 * what the app *misses*; that still needs recordings with known mistakes.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createJiti } from 'jiti'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`)) ?? null
  if (hit) return hit.split('=')[1]
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback
}

const surahs = arg('surahs', '1,78,97,112,103').split(',').map(Number)
const reciterFilter = arg('reciters', '')
const asJson = process.argv.includes('--json')
/**
 * A file from tools/measure-segments.mjs, whose durations are the *voiced* sound inside each
 * published segment. Strongly preferred: the raw segments this script fetches otherwise run up
 * to where the next word starts, so they include the pause after every word and the whole
 * breath after every ayah, which inflates a reciter's ḥaraka by half again and turns correct
 * madds into faults.
 */
const measuredFile = arg('segments', '')
const measure = arg('measure', 'voicedMs')

const jiti = createJiti(import.meta.url)
const { parseTajweedMarkup, applyDerivedRuleSpans, segmentsToWords } = await jiti.import(resolve('src/lib/tajweed.ts'))
const { estimateHaraka, measureRules, scanForFalseAlarms } = await jiti.import(resolve('src/lib/calibration.ts'))
const { paceOf } = await jiti.import(resolve('src/lib/recitationPace.ts'))

const getJson = async (url) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

/** Words per ayah, as this build derives them. */
async function passageOf(surah) {
  const data = await getJson(`https://api.alquran.cloud/v1/surah/${surah}/quran-tajweed`)
  const byAyah = new Map()
  for (const ayah of data.data.ayahs) {
    byAyah.set(`${surah}:${ayah.numberInSurah}`, segmentsToWords(applyDerivedRuleSpans(parseTajweedMarkup(ayah.text))))
  }
  return byAyah
}

const reciters = (await getJson('https://api.qurancdn.com/api/qdc/audio/reciters?language=ar')).reciters
  // Only Ḥafṣ: this build's rules, text and madd measures are all his, and a Warsh reading
  // measured by them would produce nonsense in both directions.
  .filter((r) => (r.qirat?.name ?? '').toLowerCase() === 'hafs')
  .filter((r) => !reciterFilter || reciterFilter.split(',').includes(String(r.id)))

const samples = []
const mismatches = []
const usedReciters = []

const measuredRows = measuredFile ? JSON.parse(readFileSync(measuredFile, 'utf8')) : null
const surahList = measuredRows ? [...new Set(measuredRows.map((r) => r.surah))] : surahs
const passages = new Map()
for (const surah of surahList) passages.set(surah, await passageOf(surah))

if (measuredRows) {
  // Rows are grouped per reciter and ayah; a word count that disagrees with the text means the
  // two sources disagree about where the words are, and measuring across that would assign one
  // word's duration to another.
  const byAyah = new Map()
  for (const row of measuredRows) {
    const key = `${row.reciter}|${row.ayahKey}`
    byAyah.set(key, [...(byAyah.get(key) ?? []), row])
  }
  for (const [key, list] of byAyah) {
    const [name, ayahKey] = key.split('|')
    const surah = Number(ayahKey.split(':')[0])
    const words = passages.get(surah)?.get(ayahKey)
    if (!words) continue
    if (list.length !== words.length) {
      mismatches.push({ reciter: name, ayah: ayahKey, words: words.length, segments: list.length })
      continue
    }
    list.sort((a, b) => a.wordIndex - b.wordIndex)
    list.forEach((row, i) => {
      const ms = row[measure]
      if (ms > 0) samples.push({ reciter: name, ayahKey, word: words[i], measuredMs: ms })
    })
    if (!usedReciters.includes(name)) usedReciters.push(name)
  }
  process.stderr.write(`  ${samples.length} measured words from ${usedReciters.length} reciters\n`)
}

for (const reciter of measuredRows ? [] : reciters) {
  const name = reciter.translated_name?.name ?? reciter.name
  let got = 0
  for (const surah of surahs) {
    let files
    try {
      files = await getJson(
        `https://api.qurancdn.com/api/qdc/audio/reciters/${reciter.id}/audio_files?chapter=${surah}&segments=true`,
      )
    } catch {
      continue
    }
    for (const file of files.audio_files ?? []) {
      for (const timing of file.verse_timings ?? []) {
        const words = passages.get(surah)?.get(timing.verse_key)
        const segments = (timing.segments ?? []).filter((s) => Array.isArray(s) && s.length >= 3)
        if (!words || segments.length === 0) continue
        // A word count that does not match means the two sources disagree about where the
        // words are; measuring across that disagreement would assign one word's duration to
        // another. Reported and skipped.
        if (segments.length !== words.length) {
          mismatches.push({ reciter: name, ayah: timing.verse_key, words: words.length, segments: segments.length })
          continue
        }
        segments.forEach((segment, i) => {
          const ms = segment[2] - segment[1]
          if (ms > 0) {
            samples.push({ reciter: name, ayahKey: timing.verse_key, word: words[i], measuredMs: ms })
            got++
          }
        })
      }
    }
  }
  if (got > 0) usedReciters.push(name)
  process.stderr.write(`  ${name}: ${got} words\n`)
}

const harakaByReciter = new Map()
for (const name of usedReciters) {
  const estimate = estimateHaraka(name, samples.filter((s) => s.reciter === name))
  if (estimate) harakaByReciter.set(name, estimate)
}

const rules = measureRules(samples, harakaByReciter)
const scans = [...harakaByReciter.values()].map((haraka) =>
  scanForFalseAlarms(haraka.reciter, samples.filter((s) => s.reciter === haraka.reciter), haraka),
)

if (asJson) {
  console.log(JSON.stringify({ harakaByReciter: [...harakaByReciter.values()], rules, scans, mismatches }, null, 2))
} else {
  console.log(`\nسور: ${surahs.join(', ')}  ·  قرّاء: ${harakaByReciter.size}  ·  كلمات: ${samples.length}`)
  console.log('\n— الحركة المقيسة لكل قارئ (من كلماته الخالية من الأحكام المدّية) —')
  console.log('reciter                          haraka   pace        n')
  for (const h of harakaByReciter.values()) {
    console.log(
      `${h.reciter.padEnd(30)} ${String(Math.round(h.harakaMs)).padStart(6)}ms  ${paceOf(h.paceId).nameAr.padEnd(8)} ${String(h.samples).padStart(4)}`,
    )
  }

  console.log('\n— الحركات المقيسة فعلًا لكل حكم (الوسيط، والمدى الذي يتحرّك فيه القرّاء) —')
  console.log('rule                       n   reciters   measured (p10–p90)      app asks')
  for (const r of rules) {
    console.log(
      `${r.rule.padEnd(24)} ${String(r.samples).padStart(4)} ${String(r.reciters).padStart(6)}     ` +
        `${r.medianHarakat.toFixed(1).padStart(5)} (${r.p10Harakat.toFixed(1)}–${r.p90Harakat.toFixed(1)})`.padEnd(24) +
        `${r.expectedHarakat.toFixed(1)}`,
    )
  }

  console.log('\n— الإنذارات الكاذبة: أحكام أنكرها التطبيق على قارئ معتمد —')
  let alarms = 0
  let rulingWords = 0
  for (const scan of scans) {
    alarms += scan.falseAlarms.length
    rulingWords += scan.wordsWithRulings
    const rate = scan.wordsWithRulings > 0 ? ((scan.falseAlarms.length / scan.wordsWithRulings) * 100).toFixed(1) : '—'
    console.log(
      `${scan.reciter.padEnd(30)} ${String(scan.falseAlarms.length).padStart(3)} / ${String(scan.wordsWithRulings).padStart(3)}  (${rate}%)  [${paceOf(scan.paceId).nameAr}]`,
    )
    for (const alarm of scan.falseAlarms.slice(0, 4)) {
      console.log(`    ${alarm.ayahKey}  ${alarm.word}  ${alarm.rule}  ${alarm.severity}`)
    }
  }
  console.log(
    `\nالمجموع: ${alarms} إنذارًا كاذبًا على ${rulingWords} كلمة تحمل حكمًا = ` +
      `${rulingWords > 0 ? ((alarms / rulingWords) * 100).toFixed(1) : '—'}%`,
  )
  if (mismatches.length > 0) {
    console.log(`\n⚠︎ ${mismatches.length} آية اختلف فيها المصدران في عدد الكلمات فتُركت:`)
    for (const m of mismatches.slice(0, 6)) {
      console.log(`    ${m.reciter}  ${m.ayah}: نص=${m.words} توقيت=${m.segments}`)
    }
  }
  console.log('\n⚠︎ هذا يقيس الإنذار الكاذب وحده. تلاوةٌ كلها صحيحة لا تقول شيئًا عمّا يفوت التطبيق.')
}
