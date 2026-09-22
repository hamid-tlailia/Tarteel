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
import { scoreTranscriptMatch } from '../lib/transcriptMatch'
import { buildCoachTips } from '../lib/coach'
import {
  bucketByAyah,
  buildWordVerdicts,
  isConfidenceUsable,
  PASSAGE_MATCH_FLOOR,
  type AyahRange,
  type WordVerdict,
} from '../lib/verdicts'
import { LiveTajweedTracker, type LiveSnapshot, type LiveWordResult } from '../lib/liveTracker'
import { expectedDurationBreakdown } from '../lib/wordTiming'
import { useWhisper } from '../asr/useWhisper'
import { decodeToPcm16k, MicRecorder, trimSilence } from '../asr/audio'
import type { TimedChunk } from '../asr/whisper.worker'
import { useProgressStore } from '../store/progressStore'

const MIN_SPEECH_SAMPLES = 8000 // ~0.5s at 16kHz, after silence trimming
// Tolerance band for the live timing tracker (0=very lenient, 1=strict) — see tauTolerance
// in liveTracker.ts. Not user-configurable yet; a reasonable middle ground for a first pass.
const LIVE_TAU = 0.45
const LIVE_SNAPSHOT_INTERVAL_MS = 80

function hypWordsFromResult(text: string, chunks: TimedChunk[]) {
  if (chunks.length > 0) {
    const raw = chunks.map((c) => c.text.trim())
    return { raw, normalized: raw.map(normalizeArabic) }
  }
  const raw = text.split(/\s+/).filter(Boolean)
  return { raw, normalized: raw.map(normalizeArabic) }
}

/** The raw measurements behind one word's verdict, surfaced for threshold tuning. */
interface WordDiagnostic {
  refIndex: number
  word: string
  confidence: number | null
  freeStatus: AlignedWord['status'] | null
  measuredMs: number | null
  expectedMs: number
  expectedWithoutMaddMs: number
}

function vibrate(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern)
  }
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

        // A colour alone is ambiguous — the reference text above is *also* coloured, by
        // rule, so a hue there means "this word contains a ghunnah", while the same hue
        // here would mean "you shortened it". The rule and the fault are named in words
        // under every flagged word so the two can never be confused.
        if (acoustic) {
          const severe = acoustic.severity === 'severe'
          const ruleName = TAJWEED_RULE_MAP[acoustic.rule].nameAr
          const fault =
            acoustic.kind === 'ghunnah'
              ? severe
                ? 'لم تظهر الغُنّة'
                : 'الغُنّة أقصر من المطلوب'
              : severe
                ? 'لم يُمدّ إطلاقًا'
                : 'المدّ أقصر من المطلوب'
          return (
            <span key={v.refIndex} className="inline-flex flex-col items-center gap-0.5">
              <span
                className={clsx(
                  'rounded-lg px-1.5 py-0.5 underline decoration-wavy',
                  severe ? 'bg-severe-soft text-severe decoration-severe' : 'bg-warn-soft text-warn decoration-warn',
                )}
              >
                {refWord?.word}
              </span>
              <span className={clsx('font-sans text-[10px] font-bold leading-tight', severe ? 'text-severe' : 'text-warn')}>
                {ruleName}: {fault}
              </span>
            </span>
          )
        }

        if (hasQalqalahIssue) {
          return (
            <span key={v.refIndex} className="inline-flex flex-col items-center gap-0.5">
              <span className="rounded-lg bg-qalqalah-soft px-1.5 py-0.5 text-qalqalah underline decoration-wavy decoration-qalqalah">
                {refWord?.word}
              </span>
              <span className="font-sans text-[10px] font-bold leading-tight text-qalqalah">القلقلة: لم تتضح</span>
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
function LiveWords({
  words,
  liveWords,
  holdProgress,
}: {
  words: WordWithRules[]
  liveWords: LiveWordResult[]
  /** What the word being recited right now has been held for, what its rules require, and
   * what they merely permit beyond that. Null between words. */
  holdProgress: { voicedMs: number; requiredMs: number; optionalMs: number } | null
}) {
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
          // The bar fills toward what the word's rules actually *require*, and completes
          // there. Anything a rule merely permits beyond that — the ʿāriḍ may be held for
          // two, four or six — sits past the finish line as a lighter track the reciter may
          // take or leave. Filling toward the sum of every madd in the word would demand
          // the longest reading of each as though it were owed, which it is not.
          const required = holdProgress?.requiredMs ?? 0
          const optional = holdProgress?.optionalMs ?? 0
          const voiced = holdProgress?.voicedMs ?? 0
          const span = required + optional
          const complete = required > 0 && voiced >= required
          const requiredWidth = span > 0 ? (required / span) * 100 : 100
          const filledWidth = span > 0 ? Math.min(100, (voiced / span) * 100) : 0

          return (
            <span key={i} className="relative inline-block px-1.5 pb-2 pt-0.5">
              <span
                className={clsx(
                  'rounded-lg px-1 ring-1 transition-colors',
                  complete ? 'bg-ok/15 text-ok ring-ok/50' : 'bg-accent-soft text-accent ring-gold/60',
                )}
              >
                {w.word}
              </span>
              <span aria-hidden className="absolute inset-x-1 bottom-0 h-1.5 overflow-hidden rounded-full bg-line-soft">
                {/* The permitted-but-optional stretch, shown dimmer so it never reads as owed. */}
                {optional > 0 && (
                  <span
                    className="absolute inset-y-0 right-0 bg-gold/20"
                    style={{ width: `${100 - requiredWidth}%` }}
                  />
                )}
                <span
                  className={clsx('absolute inset-y-0 right-0 rounded-full transition-[width] duration-100', complete ? 'bg-ok' : 'bg-gold')}
                  style={{ width: `${filledWidth}%` }}
                />
                {/* The finish line: where the obligation ends and choice begins. */}
                {optional > 0 && (
                  <span className="absolute inset-y-0 w-px bg-ok/70" style={{ right: `${requiredWidth}%` }} />
                )}
              </span>
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

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * The recorder control. The ring around the button tracks the microphone's actual level, so
 * a reciter can see they are being heard before committing to a whole passage — the previous
 * plain button gave no indication of that at all, and a recording that turned out to be too
 * quiet was only discovered after the analysis had run.
 */
function Recorder({
  recording,
  busy,
  micLevel,
  elapsedMs,
  onStart,
  onStop,
}: {
  recording: boolean
  busy: boolean
  micLevel: number
  elapsedMs: number
  onStart: () => void
  onStop: () => void
}) {
  const level = Math.min(1, Math.max(0, micLevel))
  const quiet = recording && elapsedMs > 1500 && level < 0.08

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="relative flex h-28 w-28 items-center justify-center">
        {recording && (
          <>
            <span
              aria-hidden
              className="absolute rounded-full bg-danger/20 transition-all duration-100"
              style={{ width: `${72 + level * 44}px`, height: `${72 + level * 44}px` }}
            />
            <span aria-hidden className="absolute h-[84px] w-[84px] animate-ping rounded-full bg-danger/15" />
          </>
        )}
        <button
          onClick={recording ? onStop : onStart}
          disabled={busy}
          aria-label={recording ? 'إيقاف التسجيل وتحليل التلاوة' : 'ابدأ التسجيل'}
          className={clsx(
            'relative flex h-[72px] w-[72px] items-center justify-center rounded-full text-white shadow-lg transition-transform active:scale-95 disabled:opacity-50',
            recording ? 'bg-danger' : 'bg-accent',
          )}
          style={{ boxShadow: recording ? '0 8px 28px -8px var(--c-danger)' : '0 8px 28px -8px var(--c-accent)' }}
        >
          {recording ? <StopIcon className="h-7 w-7" /> : <PracticeIcon className="h-8 w-8" />}
        </button>
      </div>

      <div className="flex min-h-[1.5rem] flex-col items-center gap-1">
        {recording ? (
          <>
            <span className="font-mono text-lg font-bold tabular-nums text-ink">{formatElapsed(elapsedMs)}</span>
            <span className={clsx('text-xs font-semibold', quiet ? 'text-warn' : 'text-faint')}>
              {quiet ? 'الصوت خافت — اقترب من الميكروفون' : 'يستمع… اقرأ الآيات بترتيل'}
            </span>
          </>
        ) : busy ? (
          <span className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-gold border-t-transparent" aria-hidden />
            جارٍ تحليل التلاوة…
          </span>
        ) : (
          <span className="text-sm font-semibold text-muted">اضغط لبدء التسجيل</span>
        )}
      </div>
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
  const [passageMatch, setPassageMatch] = useState(0)
  const [diagnostics, setDiagnostics] = useState<WordDiagnostic[]>([])
  const [orthographyVariant, setOrthographyVariant] = useState<string | null>(null)
  const [micLevel, setMicLevel] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)

  const recorderRef = useRef<MicRecorder | null>(null)
  const liveTrackerRef = useRef<LiveTajweedTracker | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const snapshotIntervalRef = useRef<number | null>(null)
  const latestRmsRef = useRef(0)
  const startedAtRef = useRef(0)
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

  const coachTips = useMemo(() => {
    if (!wordVerdicts) return []
    return buildCoachTips({
      referenceWords,
      wrongRefIndices: wordVerdicts.filter((v) => v.status === 'wrong').map((v) => v.refIndex),
      acousticAlerts,
      qalqalahAlerts,
    })
  }, [wordVerdicts, referenceWords, acousticAlerts, qalqalahAlerts])

  function resetResult() {
    setAligned(null)
    setWordConfidences(null)
    setAcousticAlerts([])
    setQalqalahAlerts([])
    setHypothesis(null)
    setLiveSnapshot(null)
    setPassageMatch(0)
    setDiagnostics([])
    setOrthographyVariant(null)
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
    latestRmsRef.current = 0
    setMicLevel(0)
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

    // How much this transcription looks like the selected passage at all — shown to the
    // reciter when it is too low for the score to mean anything.
    const passage = scoreTranscriptMatch(collapsed.normalized, referenceNormalized)
    setPassageMatch(passage.score)

    const verdicts = buildWordVerdicts(result, resultConfidences, referenceWords.length, ayahRanges)

    // The raw numbers behind every verdict. The thresholds these feed are reasoned rather
    // than measured — there is no corpus of real recitations to calibrate them against — so
    // the panel that shows this is how a real attempt on a real device gets turned into
    // evidence for tuning them.
    setDiagnostics(
      referenceWords.map((refWord, i) => {
        const timing = resultTimings?.[i] ?? null
        const expected = expectedDurationBreakdown(refWord)
        return {
          refIndex: i,
          word: refWord.word,
          confidence: resultConfidences?.[i] ?? null,
          freeStatus: verdicts[i]?.freeStatus ?? null,
          measuredMs: timing ? Math.round((timing[1] - timing[0]) * 1000) : null,
          expectedMs: expected.total,
          expectedWithoutMaddMs: expected.withoutMadd,
        }
      }),
    )
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
      startedAtRef.current = performance.now()
      setElapsedMs(0)
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
            latestRmsRef.current = rms
            tr.feed(rms, performance.now())
            rafIdRef.current = requestAnimationFrame(feedLoop)
          }
          rafIdRef.current = requestAnimationFrame(feedLoop)

          snapshotIntervalRef.current = window.setInterval(() => {
            const tr = liveTrackerRef.current
            if (tr) setLiveSnapshot(tr.snapshot())
            // Speech RMS sits well below 1, so scale it into a usable 0–1 meter range.
            setMicLevel(Math.min(1, latestRmsRef.current * 12))
            setElapsedMs(performance.now() - startedAtRef.current)
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
      // Forced decoding is fed the words as the muṣḥaf actually spells them, NOT the
      // comparison-normalized form: it asks the model to justify these exact tokens, so the
      // spelling has to be one the model would itself produce. (The worker tries a few
      // spellings of these and keeps whichever scores best — see orthography.ts.)
      const {
        text,
        chunks: resultChunks,
        wordConfidences: confidences,
        wordTimings: timings,
        orthographyVariant,
      } = await whisper.transcribe(trimmed, referenceWords.map((w) => w.word))
      setOrthographyVariant(orthographyVariant)
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
          <h2 className="title-ornament mb-1 font-display text-base font-bold text-accent">النص المرجعي</h2>
          {/* Without this, the rule colours here get read as a verdict on the recitation. */}
          <p className="mb-3 text-xs leading-relaxed text-faint">
            الألوان هنا تدلّ على <span className="font-bold">حكم التجويد في الكلمة</span> لا على صحة قراءتك — التقييم
            يظهر تحت «ما تقرأه الآن».
          </p>
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
                // `>= r.start`, not `>`: while the very first word of an ayah is being
                // recited the cursor still sits on it, and a strict comparison hid the
                // whole ayah behind the "not reached yet" placeholder until that word
                // finished — so the live view only ever appeared partway in.
                const reached = !!liveSnapshot?.started && liveSnapshot.cursor >= r.start
                const holdProgress =
                  liveSnapshot && liveSnapshot.currentExpectedMs > 0
                    ? {
                        voicedMs: liveSnapshot.currentVoicedMs,
                        requiredMs: liveSnapshot.currentExpectedMs,
                        optionalMs: liveSnapshot.currentOptionalMs,
                      }
                    : null
                return (
                  <div key={r.ayahNumber} className="flex items-start gap-2">
                    <div className="flex-1">
                      {reached ? (
                        <LiveWords
                          words={referenceWords.slice(r.start, r.end)}
                          liveWords={(liveSnapshot?.words ?? []).slice(r.start, r.end)}
                          holdProgress={holdProgress}
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
            <Recorder
              recording={recording}
              busy={busy}
              micLevel={micLevel}
              elapsedMs={elapsedMs}
              onStart={startRecording}
              onStop={stopRecording}
            />
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
            {!isConfidenceUsable(wordConfidences) && (
              <span className="rounded-full bg-warn-soft px-3 py-1 text-xs font-bold text-warn">
                وضع احتياطي: مطابقة نصية فقط
              </span>
            )}
          </div>

          {passageMatch < PASSAGE_MATCH_FLOOR && (
            <p className="rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm font-semibold leading-relaxed text-warn">
              ما سُمع بعيد عن نصّ المقطع المختار، فالنتيجة أعلاه غير موثوقة. تأكّد أنك تقرأ الآيات المحدّدة، وأن
              الميكروفون قريب وواضح، ثم أعد المحاولة.
            </p>
          )}

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
              <h3 className="mb-3 font-display text-base font-bold text-severe">⏱️ تنبيهات صوتية تجريبية (طول المدّ والغُنّة)</h3>
              <ul className="space-y-2.5">
                {acousticAlerts.map((a) => (
                  <li
                    key={`${a.refIndex}-${a.rule}`}
                    className={clsx(
                      'rounded-xl border p-3.5 text-sm leading-relaxed',
                      a.severity === 'severe' ? 'border-severe/40 bg-severe-soft text-severe' : 'border-warn/40 bg-warn-soft text-warn',
                    )}
                  >
                    {a.kind === 'ghunnah' ? (
                      a.severity === 'severe' ? (
                        <>
                          الغُنّة في كلمة <span className="font-quran font-bold">«{a.word}»</span> لم تظهر —{' '}
                          {TAJWEED_RULE_MAP[a.rule].nameAr} يتطلب غُنّة واضحة من الخيشوم مقدار حركتين.
                        </>
                      ) : (
                        <>
                          الغُنّة في كلمة <span className="font-quran font-bold">«{a.word}»</span> أقصر من المطلوب —{' '}
                          {TAJWEED_RULE_MAP[a.rule].nameAr} يتطلب إتمام الحركتين.
                        </>
                      )
                    ) : a.severity === 'severe' ? (
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

          {diagnostics.length > 0 && (
            <details className="rounded-xl border border-line-soft bg-bg/40">
              <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-muted">
                🔬 الأرقام الخام للتحليل (لضبط الحساسية)
              </summary>
              <div className="overflow-x-auto px-4 pb-4">
                <p className="mb-3 text-xs leading-relaxed text-faint">
                  تطابق المقطع ككل: {Math.round(passageMatch * 100)}% · رسم النص المعتمد للمطابقة الصوتية:{' '}
                  {orthographyVariant ?? 'غير متاح'} · إشارة الثقة:{' '}
                  {isConfidenceUsable(wordConfidences) ? 'صالحة' : 'مهمَلة (مسطّحة قرب الصفر)'}. «الثقة» احتمال النموذج
                  للكلمة، و«المقيس/المتوقع» زمنها بالملي ثانية.
                </p>
                <table className="w-full text-right text-xs" dir="rtl">
                  <thead className="text-faint">
                    <tr>
                      <th className="pb-1.5 font-bold">الكلمة</th>
                      <th className="pb-1.5 font-bold">الثقة</th>
                      <th className="pb-1.5 font-bold">النص</th>
                      <th className="pb-1.5 font-bold">المقيس</th>
                      <th className="pb-1.5 font-bold">المتوقع</th>
                      <th className="pb-1.5 font-bold">بلا مدّ</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-muted">
                    {diagnostics.map((d) => (
                      <tr key={d.refIndex} className="border-t border-line-soft/60">
                        <td className="py-1.5 font-quran text-sm">{d.word}</td>
                        <td className="py-1.5">{d.confidence === null ? '—' : `${(d.confidence * 100).toFixed(1)}%`}</td>
                        <td className="py-1.5">{d.freeStatus ?? '—'}</td>
                        <td className="py-1.5">{d.measuredMs === null ? '—' : d.measuredMs}</td>
                        <td className="py-1.5">{d.expectedMs}</td>
                        <td className="py-1.5">{d.expectedWithoutMaddMs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {coachTips.length > 0 && (
            <div>
              <h3 className="title-ornament mb-3 font-display text-base font-bold text-accent">ما الذي تصلحه في المحاولة القادمة</h3>
              <ul className="space-y-2.5">
                {coachTips.map((tip) => (
                  <li
                    key={tip.key}
                    className={clsx(
                      'rounded-xl border p-3.5 text-sm leading-relaxed',
                      tip.severity === 'high' ? 'border-danger/30 bg-danger-soft/40' : 'border-warn/30 bg-warn-soft/40',
                    )}
                  >
                    <span className={clsx('font-display font-bold', tip.severity === 'high' ? 'text-danger' : 'text-warn')}>
                      {tip.title}:{' '}
                    </span>
                    <span className="text-muted">{tip.action}</span>
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
