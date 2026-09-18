import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchSurahAyahs, fetchSurahList } from '../api/quran'
import type { Ayah, SurahMeta } from '../types/quran'
import { TajweedText } from '../components/TajweedText'
import { primaryRule, segmentsToWords, TAJWEED_RULE_MAP, type WordWithRules } from '../lib/tajweed'
import { normalizeArabic } from '../lib/arabicText'
import { alignWords, scoreAlignment, type AlignedWord } from '../lib/alignment'
import { detectMaddDurationAlerts, type AcousticAlert } from '../lib/acousticTajweed'
import { useWhisper } from '../asr/useWhisper'
import { decodeToPcm16k, MicRecorder } from '../asr/audio'
import type { TimedChunk } from '../asr/whisper.worker'
import { useProgressStore } from '../store/progressStore'

const LIVE_TICK_MS = 3000
const MIN_LIVE_SAMPLES = 8000 // ~0.5s at 16kHz — skip transcribing near-empty snapshots

function hypWordsFromResult(text: string, chunks: TimedChunk[]) {
  if (chunks.length > 0) {
    const raw = chunks.map((c) => c.text.trim())
    return { raw, normalized: raw.map(normalizeArabic) }
  }
  const raw = text.split(/\s+/).filter(Boolean)
  return { raw, normalized: raw.map(normalizeArabic) }
}

function vibrate(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern)
  }
}

/** Renders the recited text with each word colored: its own tajweed color when recited
 * correctly, amber when textually correct but flagged by the acoustic madd check, red when
 * wrong/missing, and a neutral tone for correct words that carry no tajweed rule. */
function ComparedWords({
  aligned,
  referenceWords,
  acousticAlerts,
}: {
  aligned: AlignedWord[]
  referenceWords: WordWithRules[]
  acousticAlerts: AcousticAlert[]
}) {
  const acousticByRefIndex = useMemo(() => new Map(acousticAlerts.map((a) => [a.refIndex, a])), [acousticAlerts])

  return (
    <div className="flex flex-wrap gap-x-1.5 gap-y-2 font-quran text-2xl" dir="rtl">
      {aligned.map((w, i) => {
        if (w.status === 'extra') {
          return (
            <span
              key={i}
              className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200"
              title="كلمة زائدة قيلت ولم ترد في النص"
            >
              {w.hypWord}
            </span>
          )
        }

        const refWord = w.refIndex !== null ? referenceWords[w.refIndex] : null
        const displayWord = refWord?.word ?? w.refWord
        const acoustic = w.refIndex !== null ? acousticByRefIndex.get(w.refIndex) : undefined
        const salientRule = refWord ? primaryRule(refWord.rules) : undefined
        const tajweedColor = salientRule ? TAJWEED_RULE_MAP[salientRule].color : null

        if (w.status !== 'correct') {
          return (
            <span
              key={i}
              className={`rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-200 ${
                w.status === 'missing' ? 'line-through decoration-2' : ''
              }`}
              title={w.status === 'substituted' ? `سمعت: ${w.hypWord}` : 'لم تُنطق'}
            >
              {displayWord}
            </span>
          )
        }

        if (acoustic) {
          return (
            <span
              key={i}
              className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 underline decoration-wavy decoration-amber-500 dark:bg-amber-900/30 dark:text-amber-200"
              title={`⏱️ المدّ يبدو قصيرًا (${TAJWEED_RULE_MAP[acoustic.rule].nameAr})`}
            >
              {displayWord}
            </span>
          )
        }

        return (
          <span key={i} className="px-1.5 py-0.5" style={tajweedColor ? { color: tajweedColor } : undefined}>
            {displayWord}
          </span>
        )
      })}
    </div>
  )
}

export function PracticePage() {
  const [surahs, setSurahs] = useState<SurahMeta[]>([])
  const [surahNumber, setSurahNumber] = useState(1)
  const [ayahs, setAyahs] = useState<Ayah[]>([])
  const [fromAyah, setFromAyah] = useState(1)
  const [toAyah, setToAyah] = useState(1)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hypothesis, setHypothesis] = useState<string | null>(null)
  const [aligned, setAligned] = useState<AlignedWord[] | null>(null)
  const [chunks, setChunks] = useState<TimedChunk[]>([])
  const [micError, setMicError] = useState<string | null>(null)
  const [isFinal, setIsFinal] = useState(false)

  const recorderRef = useRef<MicRecorder | null>(null)
  const liveTimerRef = useRef<number | null>(null)
  const liveBusyRef = useRef(false)
  const seenIssueKeysRef = useRef<Set<string>>(new Set())
  const whisper = useWhisper()
  const addAttempt = useProgressStore((s) => s.addAttempt)

  useEffect(() => {
    fetchSurahList().then(setSurahs)
  }, [])

  useEffect(() => {
    fetchSurahAyahs(surahNumber).then((a) => {
      setAyahs(a)
      setFromAyah(1)
      setToAyah(1)
      resetResult()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surahNumber])

  useEffect(() => stopLiveTimer, [])

  const selectedAyahs = useMemo(
    () => ayahs.filter((a) => a.numberInSurah >= fromAyah && a.numberInSurah <= toAyah),
    [ayahs, fromAyah, toAyah],
  )

  const referenceWords = useMemo(() => selectedAyahs.flatMap((a) => segmentsToWords(a.segments)), [selectedAyahs])
  const referenceNormalized = useMemo(() => referenceWords.map((w) => normalizeArabic(w.word)), [referenceWords])

  const meta = surahs.find((s) => s.number === surahNumber)
  const score = aligned ? scoreAlignment(aligned) : null
  const acousticAlerts = useMemo(
    () => (aligned ? detectMaddDurationAlerts(aligned, referenceWords, chunks) : []),
    [aligned, referenceWords, chunks],
  )

  const tips = useMemo(() => {
    if (!aligned) return []
    const ruleIds = new Set<string>()
    for (const w of aligned) {
      if ((w.status === 'missing' || w.status === 'substituted') && w.refIndex !== null) {
        for (const r of referenceWords[w.refIndex]?.rules ?? []) ruleIds.add(r)
      }
    }
    return [...ruleIds].map((id) => TAJWEED_RULE_MAP[id as keyof typeof TAJWEED_RULE_MAP]).filter(Boolean)
  }, [aligned, referenceWords])

  function resetResult() {
    setAligned(null)
    setChunks([])
    setHypothesis(null)
    setIsFinal(false)
    seenIssueKeysRef.current = new Set()
  }

  // Selecting the ayah range with two independent selects: moving "from" forward pulls "to"
  // along with it (and vice versa) instead of silently clamping against the other's current
  // value, which used to deadlock (e.g. typing "10" into "from" while "to" was still 1).
  function handleFromChange(value: number) {
    setFromAyah(value)
    setToAyah((prev) => Math.max(prev, value))
  }
  function handleToChange(value: number) {
    setToAyah(value)
    setFromAyah((prev) => Math.min(prev, value))
  }

  function stopLiveTimer() {
    if (liveTimerRef.current !== null) {
      window.clearInterval(liveTimerRef.current)
      liveTimerRef.current = null
    }
  }

  function applyResult(text: string, resultChunks: TimedChunk[], final: boolean) {
    setHypothesis(text)
    setChunks(resultChunks)
    const { normalized } = hypWordsFromResult(text, resultChunks)
    const result = alignWords(referenceNormalized, normalized)
    setAligned(result)
    setIsFinal(final)

    const acoustic = detectMaddDurationAlerts(result, referenceWords, resultChunks)
    const issueKeys = new Set<string>([
      ...result.filter((w) => w.status !== 'correct' && w.refIndex !== null).map((w) => `word:${w.refIndex}`),
      ...acoustic.map((a) => `madd:${a.refIndex}:${a.rule}`),
    ])
    let hasNewIssue = false
    for (const key of issueKeys) {
      if (!seenIssueKeysRef.current.has(key)) hasNewIssue = true
    }
    seenIssueKeysRef.current = issueKeys
    if (hasNewIssue) vibrate(final ? [80, 60, 80] : 120)

    return result
  }

  async function runLiveTick() {
    if (liveBusyRef.current) return
    const recorder = recorderRef.current
    if (!recorder) return
    liveBusyRef.current = true
    try {
      const blob = await recorder.snapshot()
      if (!blob) return
      const pcm = await decodeToPcm16k(blob)
      if (pcm.length < MIN_LIVE_SAMPLES) return
      const { text, chunks: resultChunks } = await whisper.transcribe(pcm)
      applyResult(text, resultChunks, false)
    } catch {
      // Transient decode/inference hiccups during live polling are non-fatal — just skip this tick.
    } finally {
      liveBusyRef.current = false
    }
  }

  const startRecording = async () => {
    setMicError(null)
    resetResult()
    try {
      const recorder = new MicRecorder()
      await recorder.start()
      recorderRef.current = recorder
      setRecording(true)
      liveTimerRef.current = window.setInterval(runLiveTick, LIVE_TICK_MS)
    } catch {
      setMicError('تعذّر الوصول إلى الميكروفون. تأكد من منح الإذن للمتصفح.')
    }
  }

  const stopRecording = async () => {
    if (!recorderRef.current) return
    stopLiveTimer()
    setRecording(false)
    setBusy(true)
    try {
      const blob = await recorderRef.current.stop()
      const pcm = await decodeToPcm16k(blob)
      const { text, chunks: resultChunks } = await whisper.transcribe(pcm)
      const result = applyResult(text, resultChunks, true)
      const s = scoreAlignment(result)
      if (meta) {
        addAttempt({
          id: crypto.randomUUID(),
          date: new Date().toISOString(),
          surah: surahNumber,
          surahName: meta.name,
          ayahFrom: fromAyah,
          ayahTo: toAyah,
          accuracy: s.accuracy,
          correct: s.correct,
          total: s.total,
        })
      }
    } catch (err) {
      setMicError((err as Error).message || 'حدث خطأ أثناء تحليل التسجيل.')
    } finally {
      setBusy(false)
    }
  }

  const ayahOptions = Array.from({ length: ayahs.length }, (_, i) => i + 1)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-black text-emerald-900 dark:text-brand-50">التلاوة والتصحيح الصوتي</h1>
        <p className="mt-1 text-sm text-emerald-900/70 dark:text-brand-100/70">
          اختر مقطعًا من القرآن، سجّل تلاوتك، وستظهر معاينة مباشرة تحت النص الصحيح كل بضع ثوانٍ أثناء القراءة —
          بمقارنة صوتية كاملة داخل متصفحك دون رفع صوتك إلى أي خادم.
        </p>
      </div>

      <div className="grid gap-3 rounded-2xl border border-brand-200/70 bg-white/70 p-4 sm:grid-cols-3 dark:border-brand-900/50 dark:bg-white/5">
        <label className="text-sm">
          <span className="mb-1 block text-emerald-900/70 dark:text-brand-100/70">السورة</span>
          <select
            value={surahNumber}
            onChange={(e) => setSurahNumber(Number(e.target.value))}
            className="w-full rounded-lg border border-brand-200 bg-white px-2 py-1.5 dark:border-brand-800 dark:bg-emerald-950"
          >
            {surahs.map((s) => (
              <option key={s.number} value={s.number}>
                {s.number}. {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-emerald-900/70 dark:text-brand-100/70">من آية</span>
          <select
            value={fromAyah}
            onChange={(e) => handleFromChange(Number(e.target.value))}
            className="w-full rounded-lg border border-brand-200 bg-white px-2 py-1.5 dark:border-brand-800 dark:bg-emerald-950"
          >
            {ayahOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-emerald-900/70 dark:text-brand-100/70">إلى آية</span>
          <select
            value={toAyah}
            onChange={(e) => handleToChange(Number(e.target.value))}
            className="w-full rounded-lg border border-brand-200 bg-white px-2 py-1.5 dark:border-brand-800 dark:bg-emerald-950"
          >
            {ayahOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-3 rounded-2xl border border-brand-200/70 bg-white/70 p-5 dark:border-brand-900/50 dark:bg-white/5">
        <div>
          <h2 className="mb-2 text-sm font-bold text-brand-700 dark:text-brand-300">النص المرجعي</h2>
          <div className="space-y-2">
            {selectedAyahs.map((a) => (
              <TajweedText key={a.number} segments={a.segments} className="font-quran text-2xl" />
            ))}
          </div>
        </div>

        {aligned && (
          <div className="border-t border-brand-100 pt-3 dark:border-brand-900/50">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-brand-700 dark:text-brand-300">
              ما تقرأه الآن
              {recording && !isFinal && (
                <span className="flex items-center gap-1 text-xs font-normal text-emerald-900/50 dark:text-brand-100/50">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" /> مباشر
                </span>
              )}
            </h2>
            <ComparedWords aligned={aligned} referenceWords={referenceWords} acousticAlerts={acousticAlerts} />
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-brand-200/70 bg-white/70 p-5 dark:border-brand-900/50 dark:bg-white/5">
        {whisper.status !== 'ready' && (
          <div>
            <p className="mb-3 text-sm text-emerald-900/80 dark:text-brand-100/80">
              يعمل التعرّف الصوتي بنموذج Whisper محمّل بالكامل داخل متصفحك (لا حاجة لخادم). يلزم تحميله مرة واحدة (~قد
              يستغرق دقيقة حسب سرعة الإنترنت).
            </p>
            {whisper.status === 'idle' && (
              <button
                onClick={whisper.load}
                className="rounded-full bg-brand-600 px-5 py-2 font-bold text-white shadow transition hover:bg-brand-700"
              >
                تحميل نموذج التعرّف الصوتي
              </button>
            )}
            {whisper.status === 'loading' && (
              <div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-brand-100 dark:bg-brand-900/40">
                  <div
                    className="h-full rounded-full bg-brand-600 transition-all"
                    style={{ width: `${whisper.progress}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-emerald-900/60 dark:text-brand-100/60">
                  جاري التحميل… {Math.round(whisper.progress)}%
                </p>
              </div>
            )}
            {whisper.status === 'error' && (
              <div>
                <p className="text-red-600">
                  تعذّر تحميل النموذج ({whisper.error ?? 'خطأ غير معروف'}). قد يكون بسبب الاتصال بالإنترنت.
                </p>
                <button
                  onClick={whisper.load}
                  className="mt-2 rounded-full bg-brand-600 px-5 py-2 font-bold text-white shadow transition hover:bg-brand-700"
                >
                  إعادة المحاولة
                </button>
              </div>
            )}
          </div>
        )}

        {whisper.status === 'ready' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {!recording ? (
                <button
                  onClick={startRecording}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-full bg-red-600 px-6 py-2.5 font-bold text-white shadow transition hover:bg-red-700 disabled:opacity-50"
                >
                  🎙️ ابدأ التسجيل
                </button>
              ) : (
                <button
                  onClick={stopRecording}
                  className="flex animate-pulse items-center gap-2 rounded-full bg-emerald-800 px-6 py-2.5 font-bold text-white shadow"
                >
                  ⏹ إيقاف وتحليل
                </button>
              )}
              {busy && <span className="text-sm text-emerald-900/60 dark:text-brand-100/60">جارٍ تحليل التلاوة…</span>}
            </div>
            {micError && <p className="text-sm text-red-600">{micError}</p>}
          </div>
        )}
      </div>

      {aligned && score && (
        <div className="space-y-5 rounded-2xl border border-brand-200/70 bg-white/70 p-5 dark:border-brand-900/50 dark:bg-white/5">
          <div className="flex flex-wrap items-center gap-4">
            <div className="text-3xl font-black text-brand-700 dark:text-brand-300">{score.accuracy}%</div>
            <div className="text-sm text-emerald-900/70 dark:text-brand-100/70">
              {score.correct} صحيحة · {score.substituted} مختلفة · {score.missing} ناقصة · {score.extra} زائدة
            </div>
            {!isFinal && (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
                نتيجة مؤقتة أثناء القراءة
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-4 text-xs text-emerald-900/60 dark:text-brand-100/60">
            <span>
              <span className="ml-1 inline-block h-3 w-3 rounded bg-brand-100 dark:bg-brand-900/40" /> صحيحة (لون التجويد إن وُجد)
            </span>
            <span>
              <span className="ml-1 inline-block h-3 w-3 rounded bg-amber-100 dark:bg-amber-900/30" /> مدّ يبدو قصيرًا
            </span>
            <span>
              <span className="ml-1 inline-block h-3 w-3 rounded bg-red-100 dark:bg-red-900/30" /> خاطئة / ناقصة
            </span>
            <span>
              <span className="ml-1 inline-block h-3 w-3 rounded bg-sky-100 dark:bg-sky-900/30" /> زائدة
            </span>
          </div>

          {hypothesis && (
            <div>
              <h3 className="mb-1 text-sm font-bold text-brand-700 dark:text-brand-300">ما تعرّف عليه النموذج</h3>
              <p className="font-quran text-lg text-emerald-900/80 dark:text-brand-100/80">{hypothesis}</p>
            </div>
          )}

          {acousticAlerts.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold text-amber-700 dark:text-amber-300">
                ⏱️ تنبيهات صوتية تجريبية (طول المدّ)
              </h3>
              <ul className="space-y-2">
                {acousticAlerts.map((a) => (
                  <li
                    key={`${a.refIndex}-${a.rule}`}
                    className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-900/20 dark:text-amber-100"
                  >
                    المدّ في كلمة <span className="font-quran font-bold">«{a.word}»</span> يبدو قصيرًا —{' '}
                    {TAJWEED_RULE_MAP[a.rule].nameAr} يتطلب مدًا أطول. حاول إطالته أكثر.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tips.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold text-brand-700 dark:text-brand-300">نصائح تجويدية للمواضع التي تحتاج انتباهًا</h3>
              <ul className="space-y-2">
                {tips.map((rule) => (
                  <li key={rule.id} className="flex items-start gap-2 rounded-lg bg-brand-50 p-3 text-sm dark:bg-brand-900/20">
                    <span className="tajweed-legend-dot mt-1.5" style={{ backgroundColor: rule.color }} />
                    <span>
                      <span className="font-bold">{rule.nameAr}: </span>
                      {rule.description}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
