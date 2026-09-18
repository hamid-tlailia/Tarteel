import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchSurahAyahs, fetchSurahList } from '../api/quran'
import type { Ayah, SurahMeta } from '../types/quran'
import { TajweedText } from '../components/TajweedText'
import { segmentsToWords, TAJWEED_RULE_MAP } from '../lib/tajweed'
import { normalizeArabic } from '../lib/arabicText'
import { alignWords, scoreAlignment, type AlignedWord } from '../lib/alignment'
import { useWhisper } from '../asr/useWhisper'
import { decodeToPcm16k, MicRecorder } from '../asr/audio'
import { useProgressStore } from '../store/progressStore'

const STATUS_STYLE: Record<AlignedWord['status'], string> = {
  correct: 'bg-brand-100 text-brand-900 dark:bg-brand-900/40 dark:text-brand-100',
  substituted: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100',
  missing: 'bg-red-100 text-red-700 line-through decoration-2 dark:bg-red-900/30 dark:text-red-200',
  extra: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200',
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
  const [micError, setMicError] = useState<string | null>(null)

  const recorderRef = useRef<MicRecorder | null>(null)
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
      setAligned(null)
      setHypothesis(null)
    })
  }, [surahNumber])

  const selectedAyahs = useMemo(
    () => ayahs.filter((a) => a.numberInSurah >= fromAyah && a.numberInSurah <= toAyah),
    [ayahs, fromAyah, toAyah],
  )

  const referenceWords = useMemo(
    () => selectedAyahs.flatMap((a) => segmentsToWords(a.segments)),
    [selectedAyahs],
  )
  const referenceNormalized = useMemo(() => referenceWords.map((w) => normalizeArabic(w.word)), [referenceWords])

  const meta = surahs.find((s) => s.number === surahNumber)

  const score = aligned ? scoreAlignment(aligned) : null

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

  const startRecording = async () => {
    setMicError(null)
    setAligned(null)
    setHypothesis(null)
    try {
      const recorder = new MicRecorder()
      await recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch {
      setMicError('تعذّر الوصول إلى الميكروفون. تأكد من منح الإذن للمتصفح.')
    }
  }

  const stopRecording = async () => {
    if (!recorderRef.current) return
    setRecording(false)
    setBusy(true)
    try {
      const blob = await recorderRef.current.stop()
      const pcm = await decodeToPcm16k(blob)
      const text = await whisper.transcribe(pcm)
      setHypothesis(text)
      const hypWords = normalizeArabic(text).split(/\s+/).filter(Boolean)
      const result = alignWords(referenceNormalized, hypWords)
      setAligned(result)
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

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-black text-emerald-900 dark:text-brand-50">التلاوة والتصحيح الصوتي</h1>
        <p className="mt-1 text-sm text-emerald-900/70 dark:text-brand-100/70">
          اختر مقطعًا من القرآن، سجّل تلاوتك، وسيقارنها نموذج ذكاء اصطناعي (Whisper) يعمل داخل متصفحك بالنص الصحيح كلمة
          بكلمة — دون رفع صوتك إلى أي خادم.
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
          <input
            type="number"
            min={1}
            max={ayahs.length}
            value={fromAyah}
            onChange={(e) => setFromAyah(Math.min(Number(e.target.value) || 1, toAyah))}
            className="w-full rounded-lg border border-brand-200 bg-white px-2 py-1.5 dark:border-brand-800 dark:bg-emerald-950"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-emerald-900/70 dark:text-brand-100/70">إلى آية</span>
          <input
            type="number"
            min={fromAyah}
            max={ayahs.length}
            value={toAyah}
            onChange={(e) => setToAyah(Math.max(Number(e.target.value) || 1, fromAyah))}
            className="w-full rounded-lg border border-brand-200 bg-white px-2 py-1.5 dark:border-brand-800 dark:bg-emerald-950"
          />
        </label>
      </div>

      <div className="rounded-2xl border border-brand-200/70 bg-white/70 p-5 dark:border-brand-900/50 dark:bg-white/5">
        <h2 className="mb-2 text-sm font-bold text-brand-700 dark:text-brand-300">النص المرجعي</h2>
        <div className="space-y-2">
          {selectedAyahs.map((a) => (
            <TajweedText key={a.number} segments={a.segments} className="font-quran text-2xl" />
          ))}
        </div>
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
          </div>

          <div>
            <h3 className="mb-2 text-sm font-bold text-brand-700 dark:text-brand-300">مقارنة كلمة بكلمة</h3>
            <div className="flex flex-wrap gap-2 font-quran text-xl" dir="rtl">
              {aligned.map((w, i) => {
                if (w.status === 'extra') {
                  return (
                    <span key={i} className={`rounded px-1.5 py-0.5 ${STATUS_STYLE.extra}`} title="كلمة زائدة قيلت ولم ترد في النص">
                      {w.hypWord}
                    </span>
                  )
                }
                const displayWord = w.refIndex !== null ? referenceWords[w.refIndex]?.word : w.refWord
                return (
                  <span
                    key={i}
                    className={`rounded px-1.5 py-0.5 ${STATUS_STYLE[w.status]}`}
                    title={w.status === 'substituted' ? `سمعت: ${w.hypWord}` : undefined}
                  >
                    {displayWord}
                  </span>
                )
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-emerald-900/60 dark:text-brand-100/60">
              <span><span className={`ml-1 inline-block h-3 w-3 rounded ${STATUS_STYLE.correct}`} /> صحيحة</span>
              <span><span className={`ml-1 inline-block h-3 w-3 rounded ${STATUS_STYLE.substituted}`} /> مختلفة عن المرجع</span>
              <span><span className={`ml-1 inline-block h-3 w-3 rounded ${STATUS_STYLE.missing}`} /> لم تُنطق</span>
              <span><span className={`ml-1 inline-block h-3 w-3 rounded ${STATUS_STYLE.extra}`} /> زائدة</span>
            </div>
          </div>

          {hypothesis && (
            <div>
              <h3 className="mb-1 text-sm font-bold text-brand-700 dark:text-brand-300">ما تعرّف عليه النموذج</h3>
              <p className="font-quran text-lg text-emerald-900/80 dark:text-brand-100/80">{hypothesis}</p>
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
