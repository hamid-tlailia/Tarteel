import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { fetchSurahAyahs, fetchSurahList } from '../api/quran'
import type { Ayah, SurahMeta } from '../types/quran'
import { TajweedText } from '../components/TajweedText'
import { PracticeIcon } from '../components/NavIcons'
import { StopIcon } from '../components/RecorderIcons'
import { primaryRule, segmentsToWords, TAJWEED_RULE_MAP, type WordWithRules } from '../lib/tajweed'
import { normalizeArabic } from '../lib/arabicText'
import { alignWords, type AlignedWord } from '../lib/alignment'
import {
  detectMaddDurationAlertsForced,
  detectMaddDurationAlertsFromFreeDecode,
  type AcousticAlert,
} from '../lib/acousticTajweed'
import { detectQalqalahIssues, type QalqalahAlert } from '../lib/qalqalah'
import { collapseRepeatedWords } from '../lib/repetition'
import { useWhisper } from '../asr/useWhisper'
import { decodeToPcm16k, MicRecorder, trimSilence } from '../asr/audio'
import type { TimedChunk } from '../asr/whisper.worker'
import { useProgressStore } from '../store/progressStore'

const LIVE_TICK_MS = 3000
const MIN_SPEECH_SAMPLES = 8000 // ~0.5s at 16kHz, after silence trimming
const MIN_NEW_SPEECH_SAMPLES = 4000 // skip a live tick if there's no meaningful new speech yet

// Forced-decoding confidence is a *relative* likelihood, not a calibrated probability — this
// threshold is a starting guess (lenient on purpose: a false "wrong" is more discouraging
// than an occasional false "correct") and will likely need tuning against real recitations.
const CONFIDENCE_THRESHOLD = 0.15

interface AyahRange {
  ayahNumber: number
  numberInSurah: number
  start: number
  end: number
}

type WordStatus = 'unreached' | 'correct' | 'wrong'

interface WordVerdict {
  refIndex: number
  status: WordStatus
  /** Forced-decoding confidence (0–1), or null when that pass wasn't available and we
   * fell back to plain text matching against the free transcription. */
  confidence: number | null
  /** What the free decode guessed in this word's place — shown as a hint, not trusted
   * for the correctness verdict itself. */
  hypGuess: string | null
  freeStatus: AlignedWord['status'] | null
}

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

/** Buckets a free-decode alignment back into per-ayah slices — used to tell how far the
 * reciter has actually gotten (an ayah with no matched hypothesis word yet hasn't been
 * "reached"), independent of React state so it can be reused from an event handler too. */
function bucketByAyah(aligned: AlignedWord[], ayahRanges: AyahRange[]): AlignedWord[][] {
  const buckets: AlignedWord[][] = ayahRanges.map(() => [])
  if (ayahRanges.length === 0) return buckets
  let ayahIdx = 0
  for (const w of aligned) {
    if (w.refIndex !== null) {
      while (ayahIdx < ayahRanges.length - 1 && w.refIndex >= ayahRanges[ayahIdx].end) ayahIdx++
    }
    buckets[Math.min(ayahIdx, buckets.length - 1)].push(w)
  }
  return buckets
}

/** The core correctness signal: forced-decoding confidence per reference word when
 * available (robust against the ASR "guessed a more common phrase" bias), falling back to
 * the free decode's exact text match if the forced pass wasn't supported this time. */
function buildWordVerdicts(
  aligned: AlignedWord[],
  wordConfidences: number[] | null,
  wordCount: number,
  ayahRanges: AyahRange[],
): WordVerdict[] {
  const alignedByAyah = bucketByAyah(aligned, ayahRanges)
  const freeByRef = new Map<number, AlignedWord>()
  for (const w of aligned) if (w.refIndex !== null) freeByRef.set(w.refIndex, w)

  return Array.from({ length: wordCount }, (_, i): WordVerdict => {
    const ayahIdx = ayahRanges.findIndex((r) => i >= r.start && i < r.end)
    const bucket = ayahIdx >= 0 ? alignedByAyah[ayahIdx] : []
    const reached = bucket.some((w) => w.hypIndex !== null)
    if (!reached) return { refIndex: i, status: 'unreached', confidence: null, hypGuess: null, freeStatus: null }

    const freeEntry = freeByRef.get(i)
    const freeStatus = freeEntry?.status ?? 'missing'
    const hypGuess = freeEntry?.hypWord ?? null

    if (wordConfidences) {
      const confidence = wordConfidences[i] ?? 0
      return { refIndex: i, status: confidence >= CONFIDENCE_THRESHOLD ? 'correct' : 'wrong', confidence, hypGuess, freeStatus }
    }
    return { refIndex: i, status: freeStatus === 'correct' ? 'correct' : 'wrong', confidence: null, hypGuess, freeStatus }
  })
}

function AyahBadge({ n }: { n: number }) {
  return (
    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-brand-300 text-[10px] font-bold text-brand-700 dark:border-brand-700 dark:text-brand-300">
      {n}
    </span>
  )
}

/** Renders one ayah's recited words: its own tajweed color when correct, orange when the
 * madd was dropped entirely, amber when just short, purple when a qalqalah bounce wasn't
 * detected, red when wrong/missing, blue for extra words the reciter said that aren't in
 * the text. */
function ComparedWords({
  verdicts,
  referenceWords,
  acousticAlerts,
  qalqalahAlerts,
  extraWords,
}: {
  verdicts: WordVerdict[]
  referenceWords: WordWithRules[]
  acousticAlerts: AcousticAlert[]
  qalqalahAlerts: QalqalahAlert[]
  extraWords: string[]
}) {
  const acousticByRefIndex = useMemo(() => new Map(acousticAlerts.map((a) => [a.refIndex, a])), [acousticAlerts])
  const qalqalahRefIndices = useMemo(() => new Set(qalqalahAlerts.map((a) => a.refIndex)), [qalqalahAlerts])

  return (
    <div className="flex flex-wrap gap-x-1.5 gap-y-2 font-quran text-2xl" dir="rtl">
      {verdicts.map((v) => {
        const refWord = referenceWords[v.refIndex]
        const salientRule = refWord ? primaryRule(refWord.rules) : undefined
        const tajweedColor = salientRule ? TAJWEED_RULE_MAP[salientRule].color : null
        const acoustic = acousticByRefIndex.get(v.refIndex)
        const hasQalqalahIssue = qalqalahRefIndices.has(v.refIndex)
        const confidenceLabel = v.confidence !== null ? ` (ثقة ${Math.round(v.confidence * 100)}%)` : ''

        if (v.status === 'wrong') {
          return (
            <span
              key={v.refIndex}
              className={clsx(
                'rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-200',
                v.freeStatus === 'missing' && 'line-through decoration-2',
              )}
              title={`${v.hypGuess ? `سمعت: ${v.hypGuess}` : 'لم يتطابق مع النص'}${confidenceLabel}`}
            >
              {refWord?.word}
            </span>
          )
        }

        if (acoustic) {
          const severe = acoustic.severity === 'severe'
          return (
            <span
              key={v.refIndex}
              className={clsx(
                'rounded px-1.5 py-0.5 underline decoration-wavy',
                severe
                  ? 'bg-orange-100 text-orange-900 decoration-orange-600 dark:bg-orange-900/30 dark:text-orange-200'
                  : 'bg-amber-100 text-amber-800 decoration-amber-500 dark:bg-amber-900/30 dark:text-amber-200',
              )}
              title={
                (severe
                  ? `⏱️ المدّ لم يُمدّ إطلاقًا (${TAJWEED_RULE_MAP[acoustic.rule].nameAr})`
                  : `⏱️ المدّ يبدو أقصر من المطلوب (${TAJWEED_RULE_MAP[acoustic.rule].nameAr})`) + confidenceLabel
              }
            >
              {refWord?.word}
            </span>
          )
        }

        if (hasQalqalahIssue) {
          return (
            <span
              key={v.refIndex}
              className="rounded bg-purple-100 px-1.5 py-0.5 text-purple-800 underline decoration-wavy decoration-purple-500 dark:bg-purple-900/30 dark:text-purple-200"
              title={`💥 قلقلة غير واضحة${confidenceLabel}`}
            >
              {refWord?.word}
            </span>
          )
        }

        return (
          <span key={v.refIndex} className="px-1.5 py-0.5" style={tajweedColor ? { color: tajweedColor } : undefined} title={confidenceLabel || undefined}>
            {refWord?.word}
          </span>
        )
      })}
      {extraWords.map((w, i) => (
        <span
          key={`extra-${i}`}
          className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200"
          title="كلمة زائدة قيلت ولم ترد في النص"
        >
          {w}
        </span>
      ))}
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
  const [wordConfidences, setWordConfidences] = useState<number[] | null>(null)
  const [acousticAlerts, setAcousticAlerts] = useState<AcousticAlert[]>([])
  const [qalqalahAlerts, setQalqalahAlerts] = useState<QalqalahAlert[]>([])
  const [micError, setMicError] = useState<string | null>(null)
  const [isFinal, setIsFinal] = useState(false)

  const recorderRef = useRef<MicRecorder | null>(null)
  const liveTimerRef = useRef<number | null>(null)
  const liveBusyRef = useRef(false)
  const lastLiveSampleCountRef = useRef(0)
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

  const { referenceWords, ayahRanges } = useMemo(() => {
    const words: WordWithRules[] = []
    const ranges: AyahRange[] = []
    for (const a of selectedAyahs) {
      const w = segmentsToWords(a.segments)
      ranges.push({ ayahNumber: a.number, numberInSurah: a.numberInSurah, start: words.length, end: words.length + w.length })
      words.push(...w)
    }
    return { referenceWords: words, ayahRanges: ranges }
  }, [selectedAyahs])

  const referenceNormalized = useMemo(() => referenceWords.map((w) => normalizeArabic(w.word)), [referenceWords])

  // Used only to tell how far the reciter has actually gotten (an ayah with no matched
  // hypothesis word yet hasn't been "reached") and to surface extra/unmatched words — not
  // for correctness anymore, that comes from wordVerdicts below.
  const alignedByAyah = useMemo(() => (aligned ? bucketByAyah(aligned, ayahRanges) : ayahRanges.map(() => [])), [aligned, ayahRanges])

  const wordVerdicts = useMemo<WordVerdict[] | null>(
    () => (aligned ? buildWordVerdicts(aligned, wordConfidences, referenceWords.length, ayahRanges) : null),
    [aligned, wordConfidences, referenceWords.length, ayahRanges],
  )

  const meta = surahs.find((s) => s.number === surahNumber)

  const score = useMemo(() => {
    if (!wordVerdicts) return null
    const reached = wordVerdicts.filter((v) => v.status !== 'unreached')
    const correct = reached.filter((v) => v.status === 'correct').length
    const total = reached.length
    return { correct, total, accuracy: total === 0 ? 0 : Math.round((correct / total) * 100) }
  }, [wordVerdicts])

  const tips = useMemo(() => {
    if (!wordVerdicts) return []
    const ruleIds = new Set<string>()
    for (const v of wordVerdicts) {
      if (v.status === 'wrong') {
        for (const r of referenceWords[v.refIndex]?.rules ?? []) ruleIds.add(r)
      }
    }
    return [...ruleIds].map((id) => TAJWEED_RULE_MAP[id as keyof typeof TAJWEED_RULE_MAP]).filter(Boolean)
  }, [wordVerdicts, referenceWords])

  function resetResult() {
    setAligned(null)
    setWordConfidences(null)
    setAcousticAlerts([])
    setQalqalahAlerts([])
    setHypothesis(null)
    setIsFinal(false)
    seenIssueKeysRef.current = new Set()
    lastLiveSampleCountRef.current = 0
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

  function applyResult(
    text: string,
    resultChunks: TimedChunk[],
    resultConfidences: number[] | null,
    resultTimings: ([number, number] | null)[] | null,
    audioForAnalysis: Float32Array,
    final: boolean,
  ) {
    const { raw, normalized } = hypWordsFromResult(text, resultChunks)
    // Defend against ASR hallucination loops (e.g. the same word repeated dozens of times
    // over a silent stretch) before they ever reach the aligner.
    const collapsed = collapseRepeatedWords(raw, normalized, resultChunks)
    const displayText = collapsed.raw.join(' ') || text

    setHypothesis(displayText)
    setWordConfidences(resultConfidences)
    const result = alignWords(referenceNormalized, collapsed.normalized)
    setAligned(result)
    setIsFinal(final)

    // Compute verdicts from these fresh local values (not the memoized state, which won't
    // reflect this update until the next render) to decide whether to vibrate for a *new*
    // problem — a word that's still wrong on the next tick shouldn't buzz again.
    const verdicts = buildWordVerdicts(result, resultConfidences, referenceWords.length, ayahRanges)
    const correctRefIndices = new Set(verdicts.filter((v) => v.status === 'correct').map((v) => v.refIndex))

    // Forced-alignment timing (precise, from the known text) is preferred; fall back to
    // the free decode's approximate word timestamps when it isn't available this time.
    const acoustic = resultTimings
      ? detectMaddDurationAlertsForced(referenceWords, resultTimings, correctRefIndices)
      : detectMaddDurationAlertsFromFreeDecode(result, referenceWords, collapsed.chunks, correctRefIndices)
    const qalqalah = resultTimings ? detectQalqalahIssues(audioForAnalysis, referenceWords, resultTimings, correctRefIndices) : []
    setAcousticAlerts(acoustic)
    setQalqalahAlerts(qalqalah)

    const issueKeys = new Set<string>([
      ...verdicts.filter((v) => v.status === 'wrong').map((v) => `word:${v.refIndex}`),
      ...acoustic.map((a) => `madd:${a.refIndex}:${a.rule}:${a.severity}`),
      ...qalqalah.map((a) => `qalqalah:${a.refIndex}`),
    ])
    let hasNewIssue = false
    for (const key of issueKeys) {
      if (!seenIssueKeysRef.current.has(key)) hasNewIssue = true
    }
    seenIssueKeysRef.current = issueKeys
    if (hasNewIssue) vibrate(final ? [80, 60, 80] : 120)

    return verdicts
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
      const trimmed = trimSilence(pcm)
      if (trimmed.length < MIN_SPEECH_SAMPLES) return
      if (trimmed.length - lastLiveSampleCountRef.current < MIN_NEW_SPEECH_SAMPLES) return
      lastLiveSampleCountRef.current = trimmed.length
      const {
        text,
        chunks: resultChunks,
        wordConfidences: confidences,
        wordTimings: timings,
      } = await whisper.transcribe(trimmed, referenceNormalized)
      applyResult(text, resultChunks, confidences, timings, trimmed, false)
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
      const trimmed = trimSilence(pcm)
      if (trimmed.length < MIN_SPEECH_SAMPLES) {
        setMicError('لم يتم رصد صوت واضح. حاول التسجيل مرة أخرى بصوت أعلى وأقرب للميكروفون.')
        return
      }
      const {
        text,
        chunks: resultChunks,
        wordConfidences: confidences,
        wordTimings: timings,
      } = await whisper.transcribe(trimmed, referenceNormalized)
      const verdicts = applyResult(text, resultChunks, confidences, timings, trimmed, true)
      if (meta) {
        const reached = verdicts.filter((v) => v.status !== 'unreached')
        const correct = reached.filter((v) => v.status === 'correct').length
        const accuracy = reached.length === 0 ? 0 : Math.round((correct / reached.length) * 100)
        addAttempt({
          id: crypto.randomUUID(),
          date: new Date().toISOString(),
          surah: surahNumber,
          surahName: meta.name,
          ayahFrom: fromAyah,
          ayahTo: toAyah,
          accuracy,
          correct,
          total: reached.length,
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
          اختر مقطعًا من القرآن، سجّل تلاوتك، وستنكشف كل آية بمقارنتها الحيّة تحت النص الصحيح كلما وصلت إليها أثناء
          القراءة — بمقارنة صوتية كاملة داخل متصفحك دون رفع صوتك إلى أي خادم.
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

      <div className="space-y-4 rounded-2xl border border-brand-200/70 bg-white/70 p-5 dark:border-brand-900/50 dark:bg-white/5">
        <div>
          <h2 className="mb-2 text-sm font-bold text-brand-700 dark:text-brand-300">النص المرجعي</h2>
          <div className="space-y-2">
            {selectedAyahs.map((a) => (
              <div key={a.number} className="flex items-start gap-2">
                <TajweedText segments={a.segments} className="font-quran flex-1 text-2xl" />
                <AyahBadge n={a.numberInSurah} />
              </div>
            ))}
          </div>
        </div>

        {(recording || wordVerdicts) && (
          <div className="border-t border-brand-100 pt-3 dark:border-brand-900/50">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-brand-700 dark:text-brand-300">
              ما تقرأه الآن
              {recording && !isFinal && (
                <span className="flex items-center gap-1 text-xs font-normal text-emerald-900/50 dark:text-brand-100/50">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" /> مباشر
                </span>
              )}
            </h2>
            <div className="space-y-3">
              {ayahRanges.map((r, idx) => {
                const bucket = alignedByAyah[idx] ?? []
                const reached = bucket.some((w) => w.hypIndex !== null)
                const verdictsForAyah = (wordVerdicts ?? []).slice(r.start, r.end)
                const extraWords = bucket.filter((w) => w.status === 'extra').map((w) => w.hypWord ?? '')
                return (
                  <div key={r.ayahNumber} className="flex items-start gap-2">
                    <div className="flex-1">
                      {reached ? (
                        <ComparedWords
                          verdicts={verdictsForAyah}
                          referenceWords={referenceWords}
                          acousticAlerts={acousticAlerts}
                          qalqalahAlerts={qalqalahAlerts}
                          extraWords={extraWords}
                        />
                      ) : (
                        <div className="rounded-lg border border-dashed border-brand-200/70 bg-brand-50/40 px-3 py-2.5 text-sm text-emerald-900/30 dark:border-brand-800/60 dark:bg-white/5 dark:text-brand-100/30">
                          ⋯ لم تصل إلى هذه الآية بعد
                        </div>
                      )}
                    </div>
                    <AyahBadge n={r.numberInSurah} />
                  </div>
                )
              })}
            </div>
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
                  <PracticeIcon className="h-5 w-5" />
                  ابدأ التسجيل
                </button>
              ) : (
                <button
                  onClick={stopRecording}
                  className="flex items-center gap-2 rounded-full bg-emerald-600 px-6 py-2.5 font-bold text-white shadow transition hover:bg-emerald-700"
                >
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
                  </span>
                  <StopIcon className="h-5 w-5" />
                  إيقاف وتحليل
                </button>
              )}
              {busy && <span className="text-sm text-emerald-900/60 dark:text-brand-100/60">جارٍ تحليل التلاوة…</span>}
            </div>
            {micError && <p className="text-sm text-red-600">{micError}</p>}
          </div>
        )}
      </div>

      {wordVerdicts && score && (
        <div className="space-y-5 rounded-2xl border border-brand-200/70 bg-white/70 p-5 dark:border-brand-900/50 dark:bg-white/5">
          <div className="flex flex-wrap items-center gap-4">
            <div className="text-3xl font-black text-brand-700 dark:text-brand-300">{score.accuracy}%</div>
            <div className="text-sm text-emerald-900/70 dark:text-brand-100/70">
              {score.correct} صحيحة من {score.total}
            </div>
            {!isFinal && (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
                نتيجة مؤقتة أثناء القراءة
              </span>
            )}
            {!wordConfidences && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                وضع احتياطي: مطابقة نصية فقط
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-4 text-xs text-emerald-900/60 dark:text-brand-100/60">
            <span>
              <span className="ml-1 inline-block h-3 w-3 rounded bg-brand-100 dark:bg-brand-900/40" /> صحيحة (لون التجويد إن وُجد)
            </span>
            <span>
              <span className="ml-1 inline-block h-3 w-3 rounded bg-amber-100 dark:bg-amber-900/30" /> مدّ أقصر من المطلوب
            </span>
            <span>
              <span className="ml-1 inline-block h-3 w-3 rounded bg-orange-100 dark:bg-orange-900/30" /> مدّ لم يُمدّ إطلاقًا
            </span>
            <span>
              <span className="ml-1 inline-block h-3 w-3 rounded bg-red-100 dark:bg-red-900/30" /> خاطئة / ناقصة
            </span>
            <span>
              <span className="ml-1 inline-block h-3 w-3 rounded bg-sky-100 dark:bg-sky-900/30" /> زائدة
            </span>
            <span>
              <span className="ml-1 inline-block h-3 w-3 rounded bg-purple-100 dark:bg-purple-900/30" /> قلقلة غير واضحة
            </span>
          </div>

          {hypothesis && (
            <div>
              <h3 className="mb-1 text-sm font-bold text-brand-700 dark:text-brand-300">ما تعرّف عليه النموذج (توضيحي فقط)</h3>
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
                    className={clsx(
                      'rounded-lg p-3 text-sm',
                      a.severity === 'severe'
                        ? 'bg-orange-50 text-orange-900 dark:bg-orange-900/20 dark:text-orange-100'
                        : 'bg-amber-50 text-amber-900 dark:bg-amber-900/20 dark:text-amber-100',
                    )}
                  >
                    {a.severity === 'severe' ? (
                      <>
                        المدّ في كلمة <span className="font-quran font-bold">«{a.word}»</span> لم يُمدّ إطلاقًا —{' '}
                        {TAJWEED_RULE_MAP[a.rule].nameAr} يتطلب مدًا واضحًا، لا مجرد نطق عادي.
                      </>
                    ) : (
                      <>
                        المدّ في كلمة <span className="font-quran font-bold">«{a.word}»</span> يبدو أقصر من المطلوب —{' '}
                        {TAJWEED_RULE_MAP[a.rule].nameAr} يتطلب مدًا أطول قليلًا.
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {qalqalahAlerts.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold text-purple-700 dark:text-purple-300">
                💥 تنبيهات صوتية تجريبية (القلقلة)
              </h3>
              <ul className="space-y-2">
                {qalqalahAlerts.map((a) => (
                  <li
                    key={a.refIndex}
                    className="rounded-lg bg-purple-50 p-3 text-sm text-purple-900 dark:bg-purple-900/20 dark:text-purple-100"
                  >
                    القلقلة في كلمة <span className="font-quran font-bold">«{a.word}»</span> لم تظهر بوضوح — حاول
                    إبراز ارتداد الصوت (النبرة) عند نطق الحرف الساكن.
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
