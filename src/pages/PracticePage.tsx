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
import { LiveTajweedTracker, type LiveSnapshot, type LiveWordResult } from '../lib/liveTracker'
import { useWhisper } from '../asr/useWhisper'
import { decodeToPcm16k, MicRecorder, trimSilence } from '../asr/audio'
import type { TimedChunk } from '../asr/whisper.worker'
import { useProgressStore } from '../store/progressStore'

const MIN_SPEECH_SAMPLES = 8000 // ~0.5s at 16kHz, after silence trimming
// Tolerance band for the live timing tracker (0=very lenient, 1=strict) — see tauTolerance
// in liveTracker.ts. Not user-configurable yet; a reasonable middle ground for a first pass.
const LIVE_TAU = 0.45
const LIVE_SNAPSHOT_INTERVAL_MS = 120

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
    <span aria-label={`الآية ${n}`} className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center text-[10px] font-black text-gold">
      <span aria-hidden className="absolute inset-0 rotate-45 rounded-[6px] border border-gold/60 bg-accent-soft/50" />
      <span className="relative">{n}</span>
    </span>
  )
}

/** Renders one ayah's recited words: its own tajweed color when correct, severe-orange when
 * the madd was dropped entirely, amber when just short, purple when a qalqalah bounce wasn't
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
              className={clsx('rounded-lg bg-danger-soft px-1.5 py-0.5 text-danger', v.freeStatus === 'missing' && 'line-through decoration-2')}
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
                'rounded-lg px-1.5 py-0.5 underline decoration-wavy',
                severe ? 'bg-severe-soft text-severe decoration-severe' : 'bg-warn-soft text-warn decoration-warn',
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
              className="rounded-lg bg-qalqalah-soft px-1.5 py-0.5 text-qalqalah underline decoration-wavy decoration-qalqalah"
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
        <span key={`extra-${i}`} className="rounded-lg bg-info-soft px-1.5 py-0.5 text-info" title="كلمة زائدة قيلت ولم ترد في النص">
          {w}
        </span>
      ))}
    </div>
  )
}

/** Renders one ayah's words while still recording, colored by the live RMS/VAD tracker's
 * *timing* verdict alone (no ASR involved yet — see liveTracker.ts): the in-progress word
 * pulses gold, a well-timed word shows its own tajweed color, a mistimed one turns amber
 * (short/long) or red (nothing heard), and anything not reached yet stays faint. Word
 * *correctness* (right/wrong text) only becomes available once, from the single Whisper
 * pass that runs after the reciter stops — see ComparedWords for that final rendering. */
function LiveWords({ words, liveWords }: { words: WordWithRules[]; liveWords: LiveWordResult[] }) {
  return (
    <div className="flex flex-wrap gap-x-1.5 gap-y-2 font-quran text-2xl" dir="rtl">
      {words.map((w, i) => {
        const live = liveWords[i]
        const salientRule = primaryRule(w.rules)
        const tajweedColor = salientRule ? TAJWEED_RULE_MAP[salientRule].color : null

        if (!live || live.status === 'pending') {
          return (
            <span key={i} className="px-1.5 py-0.5 text-faint/50">
              {w.word}
            </span>
          )
        }
        if (live.status === 'current') {
          return (
            <span key={i} className="animate-pulse rounded-lg bg-accent-soft px-1.5 py-0.5 text-accent ring-1 ring-gold/60">
              {w.word}
            </span>
          )
        }
        if (live.status === 'short' || live.status === 'long') {
          return (
            <span
              key={i}
              className="rounded-lg bg-warn-soft px-1.5 py-0.5 text-warn underline decoration-wavy decoration-warn"
              title={live.status === 'short' ? '⏱️ أقصر من الزمن المتوقع لهذه الكلمة' : '⏱️ أطول من الزمن المتوقع لهذه الكلمة'}
            >
              {w.word}
            </span>
          )
        }
        if (live.status === 'silent') {
          return (
            <span key={i} className="rounded-lg bg-danger-soft px-1.5 py-0.5 text-danger" title="لم يُسمع نطق واضح لهذه الكلمة">
              {w.word}
            </span>
          )
        }
        return (
          <span key={i} className="px-1.5 py-0.5" style={tajweedColor ? { color: tajweedColor } : undefined}>
            {w.word}
          </span>
        )
      })}
    </div>
  )
}

const SELECT_CLASS =
  'w-full rounded-xl border border-line bg-elevated px-3 py-2 text-sm font-medium text-ink shadow-sm transition focus:border-gold focus:outline-none'

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
  const [liveSnapshot, setLiveSnapshot] = useState<LiveSnapshot | null>(null)

  const recorderRef = useRef<MicRecorder | null>(null)
  const liveTrackerRef = useRef<LiveTajweedTracker | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const snapshotIntervalRef = useRef<number | null>(null)
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

  useEffect(() => stopLiveAnalysis, [])

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
    setLiveSnapshot(null)
    liveTrackerRef.current = null
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

  /** Tears down the live RMS analysis loop (rAF feed + snapshot interval + AudioContext)
   * without touching the MediaRecorder itself — called both on stop and on unmount. */
  function stopLiveAnalysis() {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    if (snapshotIntervalRef.current !== null) {
      window.clearInterval(snapshotIntervalRef.current)
      snapshotIntervalRef.current = null
    }
    analyserRef.current = null
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
  }

  /** Runs once, on the complete recording after the reciter stops: the single Whisper pass
   * (forced-decoding confidence + free decode + cross-attention timing) that decides word
   * correctness and computes the final acoustic/qalqalah alerts. Live-recording feedback
   * (per-ayah reveal, per-word timing) comes entirely from the RMS tracker instead — see
   * startRecording — so this no longer needs to run repeatedly or dedupe against a previous
   * tick's issues. */
  function applyResult(
    text: string,
    resultChunks: TimedChunk[],
    resultConfidences: number[] | null,
    resultTimings: ([number, number] | null)[] | null,
    audioForAnalysis: Float32Array,
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

    if (verdicts.some((v) => v.status === 'wrong') || acoustic.length > 0 || qalqalah.length > 0) {
      vibrate([80, 60, 80])
    }

    return verdicts
  }

  const startRecording = async () => {
    setMicError(null)
    resetResult()
    try {
      const recorder = new MicRecorder()
      await recorder.start()
      recorderRef.current = recorder
      setRecording(true)

      // Instant per-word timing feedback via microphone energy alone (no ASR while
      // recording) — see liveTracker.ts for why this replaced the old approach of
      // re-transcribing the growing recording with Whisper every few seconds.
      const tracker = new LiveTajweedTracker(referenceWords, LIVE_TAU, (_index, status) => {
        if (status === 'silent') vibrate([100, 50, 100])
        else if (status === 'short' || status === 'long') vibrate(60)
      })
      liveTrackerRef.current = tracker
      setLiveSnapshot(tracker.snapshot())

      const stream = recorder.getStream()
      if (stream) {
        try {
          const AudioCtx =
            window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
          const audioCtx = new AudioCtx()
          const source = audioCtx.createMediaStreamSource(stream)
          const analyser = audioCtx.createAnalyser()
          analyser.fftSize = 1024
          source.connect(analyser)
          audioCtxRef.current = audioCtx
          analyserRef.current = analyser

          const timeDomain = new Float32Array(analyser.fftSize)
          const feedLoop = () => {
            const an = analyserRef.current
            const tr = liveTrackerRef.current
            if (!an || !tr) return
            an.getFloatTimeDomainData(timeDomain)
            let sumSquares = 0
            for (let i = 0; i < timeDomain.length; i++) sumSquares += timeDomain[i] * timeDomain[i]
            const rms = Math.sqrt(sumSquares / timeDomain.length)
            tr.feed(rms, performance.now())
            rafIdRef.current = requestAnimationFrame(feedLoop)
          }
          rafIdRef.current = requestAnimationFrame(feedLoop)

          snapshotIntervalRef.current = window.setInterval(() => {
            const tr = liveTrackerRef.current
            if (tr) setLiveSnapshot(tr.snapshot())
          }, LIVE_SNAPSHOT_INTERVAL_MS)
        } catch {
          // Live per-word timing is a nice-to-have; recording itself still works without it.
        }
      }
    } catch {
      setMicError('تعذّر الوصول إلى الميكروفون. تأكد من منح الإذن للمتصفح.')
    }
  }

  const stopRecording = async () => {
    if (!recorderRef.current) return
    stopLiveAnalysis()
    liveTrackerRef.current?.finish()
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
      const verdicts = applyResult(text, resultChunks, confidences, timings, trimmed)
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
    <div className="mx-auto max-w-3xl space-y-7">
      <div>
        <h1 className="text-gilded font-display text-3xl font-bold">التلاوة والتصحيح الصوتي</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          اختر مقطعًا من القرآن، سجّل تلاوتك، وستنكشف كل آية بمقارنتها الحيّة تحت النص الصحيح كلما وصلت إليها أثناء
          القراءة — بمقارنة صوتية كاملة داخل متصفحك دون رفع صوتك إلى أي خادم.
        </p>
        <div className="hair-gold mt-4 max-w-sm" />
      </div>

      <div className="card-lux grid gap-4 p-5 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1.5 block text-xs font-bold text-faint">السورة</span>
          <select value={surahNumber} onChange={(e) => setSurahNumber(Number(e.target.value))} className={SELECT_CLASS}>
            {surahs.map((s) => (
              <option key={s.number} value={s.number}>
                {s.number}. {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1.5 block text-xs font-bold text-faint">من آية</span>
          <select value={fromAyah} onChange={(e) => handleFromChange(Number(e.target.value))} className={SELECT_CLASS}>
            {ayahOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1.5 block text-xs font-bold text-faint">إلى آية</span>
          <select value={toAyah} onChange={(e) => handleToChange(Number(e.target.value))} className={SELECT_CLASS}>
            {ayahOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card-lux space-y-5 p-6">
        <div>
          <h2 className="title-ornament mb-3 font-display text-base font-bold text-accent">النص المرجعي</h2>
          <div className="space-y-3">
            {selectedAyahs.map((a) => (
              <div key={a.number} className="ayah-frame flex items-start gap-2 p-4">
                <TajweedText segments={a.segments} className="font-quran flex-1 text-2xl" />
                <AyahBadge n={a.numberInSurah} />
              </div>
            ))}
          </div>
        </div>

        {(recording || wordVerdicts) && (
          <div className="border-t border-line pt-5">
            <h2 className="title-ornament mb-3 flex items-center gap-2 font-display text-base font-bold text-accent">
              ما تقرأه الآن
              {recording && (
                <span className="flex items-center gap-1.5 text-xs font-semibold text-faint">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-danger" />
                  </span>
                  مباشر
                </span>
              )}
            </h2>
            <div className="space-y-3">
              {ayahRanges.map((r, idx) => {
                if (wordVerdicts) {
                  const bucket = alignedByAyah[idx] ?? []
                  const reached = bucket.some((w) => w.hypIndex !== null)
                  const verdictsForAyah = wordVerdicts.slice(r.start, r.end)
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
                          <div className="rounded-xl border border-dashed border-line bg-line-soft/40 px-3 py-2.5 text-sm text-faint">
                            ⋯ لم تصل إلى هذه الآية بعد
                          </div>
                        )}
                      </div>
                      <AyahBadge n={r.numberInSurah} />
                    </div>
                  )
                }

                // Still recording: no ASR result yet — reveal progress from the live RMS
                // timing tracker alone (see LiveWords).
                const reached = (liveSnapshot?.cursor ?? 0) > r.start
                return (
                  <div key={r.ayahNumber} className="flex items-start gap-2">
                    <div className="flex-1">
                      {reached ? (
                        <LiveWords
                          words={referenceWords.slice(r.start, r.end)}
                          liveWords={(liveSnapshot?.words ?? []).slice(r.start, r.end)}
                        />
                      ) : (
                        <div className="rounded-xl border border-dashed border-line bg-line-soft/40 px-3 py-2.5 text-sm text-faint">
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

      <div className="card-lux p-6">
        {whisper.status !== 'ready' && (
          <div>
            <p className="mb-4 text-sm leading-relaxed text-muted">
              يعمل التعرّف الصوتي بنموذج Whisper محمّل بالكامل داخل متصفحك (لا حاجة لخادم). يلزم تحميله مرة واحدة (~قد
              يستغرق دقيقة حسب سرعة الإنترنت).
            </p>
            {whisper.status === 'idle' && (
              <button onClick={whisper.load} className="btn-gold">
                تحميل نموذج التعرّف الصوتي
              </button>
            )}
            {whisper.status === 'loading' && (
              <div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-line-soft">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${whisper.progress}%`,
                      background: 'linear-gradient(90deg, var(--c-gold-deep), var(--c-gold), var(--c-gold-soft))',
                    }}
                  />
                </div>
                <p className="mt-2 text-xs font-bold text-faint">جاري التحميل… {Math.round(whisper.progress)}%</p>
              </div>
            )}
            {whisper.status === 'error' && (
              <div>
                <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-bold text-danger">
                  تعذّر تحميل النموذج ({whisper.error ?? 'خطأ غير معروف'}). قد يكون بسبب الاتصال بالإنترنت.
                </p>
                <button onClick={whisper.load} className="btn-accent mt-3">
                  إعادة المحاولة
                </button>
              </div>
            )}
          </div>
        )}

        {whisper.status === 'ready' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              {!recording ? (
                <button onClick={startRecording} disabled={busy} className="btn-danger disabled:opacity-50">
                  <PracticeIcon className="h-5 w-5" />
                  ابدأ التسجيل
                </button>
              ) : (
                <button onClick={stopRecording} className="btn-accent">
                  <span className="relative flex h-2.5 w-2.5" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70" style={{ backgroundColor: 'currentColor' }} />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ backgroundColor: 'currentColor' }} />
                  </span>
                  <StopIcon className="h-5 w-5" />
                  إيقاف وتحليل
                </button>
              )}
              {busy && (
                <span className="flex items-center gap-2 text-sm font-semibold text-muted">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-gold border-t-transparent" aria-hidden />
                  جارٍ تحليل التلاوة…
                </span>
              )}
            </div>
            {micError && <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-bold text-danger">{micError}</p>}
          </div>
        )}
      </div>

      {wordVerdicts && score && (
        <div className="card-lux space-y-6 p-6">
          <div className="flex flex-wrap items-center gap-4">
            <div className="text-gilded font-display text-4xl font-bold">{score.accuracy}%</div>
            <div className="text-sm font-semibold text-muted">
              {score.correct} صحيحة من {score.total}
            </div>
            {!wordConfidences && (
              <span className="rounded-full bg-warn-soft px-3 py-1 text-xs font-bold text-warn">وضع احتياطي: مطابقة نصية فقط</span>
            )}
          </div>

          <div className="flex flex-wrap gap-4 rounded-xl border border-line-soft bg-bg/40 p-3 text-xs font-semibold text-muted">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded bg-accent-soft ring-1 ring-accent/40" /> صحيحة (لون التجويد إن وُجد)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded bg-warn-soft ring-1 ring-warn/40" /> مدّ أقصر من المطلوب
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded bg-severe-soft ring-1 ring-severe/40" /> مدّ لم يُمدّ إطلاقًا
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded bg-danger-soft ring-1 ring-danger/40" /> خاطئة / ناقصة
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded bg-info-soft ring-1 ring-info/40" /> زائدة
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded bg-qalqalah-soft ring-1 ring-qalqalah/40" /> قلقلة غير واضحة
            </span>
          </div>

          {hypothesis && (
            <div>
              <h3 className="title-ornament mb-2 font-display text-base font-bold text-accent">ما تعرّف عليه النموذج (توضيحي فقط)</h3>
              <p className="font-quran text-lg leading-loose text-muted">{hypothesis}</p>
            </div>
          )}

          {acousticAlerts.length > 0 && (
            <div>
              <h3 className="mb-3 font-display text-base font-bold text-severe">⏱️ تنبيهات صوتية تجريبية (طول المدّ)</h3>
              <ul className="space-y-2.5">
                {acousticAlerts.map((a) => (
                  <li
                    key={`${a.refIndex}-${a.rule}`}
                    className={clsx(
                      'rounded-xl border p-3.5 text-sm leading-relaxed',
                      a.severity === 'severe' ? 'border-severe/40 bg-severe-soft text-severe' : 'border-warn/40 bg-warn-soft text-warn',
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
              <h3 className="mb-3 font-display text-base font-bold text-qalqalah">💥 تنبيهات صوتية تجريبية (القلقلة)</h3>
              <ul className="space-y-2.5">
                {qalqalahAlerts.map((a) => (
                  <li key={a.refIndex} className="rounded-xl border border-qalqalah/40 bg-qalqalah-soft p-3.5 text-sm leading-relaxed text-qalqalah">
                    القلقلة في كلمة <span className="font-quran font-bold">«{a.word}»</span> لم تظهر بوضوح — حاول
                    إبراز ارتداد الصوت (النبرة) عند نطق الحرف الساكن.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tips.length > 0 && (
            <div>
              <h3 className="title-ornament mb-3 font-display text-base font-bold text-accent">نصائح تجويدية للمواضع التي تحتاج انتباهًا</h3>
              <ul className="space-y-2.5">
                {tips.map((rule) => (
                  <li key={rule.id} className="flex items-start gap-3 rounded-xl border border-line-soft bg-accent-soft/50 p-3.5 text-sm leading-relaxed">
                    <span className="tajweed-legend-dot mt-1.5 shrink-0" style={{ backgroundColor: rule.color, color: rule.color }} />
                    <span className="text-muted">
                      <span className="font-display font-bold text-ink">{rule.nameAr}: </span>
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
