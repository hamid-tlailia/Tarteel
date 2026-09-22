import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { fetchSurahAyahs, fetchSurahList } from '../api/quran'
import type { Ayah, SurahMeta, TajweedRuleId } from '../types/quran'
import { TajweedText } from '../components/TajweedText'
import { PracticeIcon } from '../components/NavIcons'
import { Dropdown } from '../components/Dropdown'
import { StopIcon } from '../components/RecorderIcons'
import { primaryRule, segmentsToWords, TAJWEED_RULE_MAP, type WordWithRules } from '../lib/tajweed'
import { normalizeArabic } from '../lib/arabicText'
import { alignWords, type AlignedWord } from '../lib/alignment'
import {
  detectMaddDurationAlertsForced,
  detectMaddDurationAlertsFromFreeDecode,
  detectRecitedPace,
  type AcousticAlert,
} from '../lib/acousticTajweed'
import { DEFAULT_PACE_ID, PACES, paceOf, type PaceId, type PaceProfile } from '../lib/recitationPace'
import { detectQalqalahIssues, type QalqalahAlert } from '../lib/qalqalah'
import { collapseRepeatedWords } from '../lib/repetition'
import { scoreTranscriptMatch } from '../lib/transcriptMatch'
import { buildCoachTips } from '../lib/coach'
import { detectGhunnahNasalityAlerts, measureWordTimbre, type NasalityAlert } from '../lib/nasality'
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
import { decodeToPcm16k, MicRecorder, TARGET_SAMPLE_RATE, trimSilence } from '../asr/audio'
import type { TimedChunk } from '../asr/whisper.worker'
import { useProgressStore } from '../store/progressStore'

const MIN_SPEECH_SAMPLES = 8000 // ~0.5s at 16kHz, after silence trimming
// Tolerance band for the live timing tracker (0=very lenient, 1=strict) — see tauTolerance
// in liveTracker.ts. Not user-configurable yet; a reasonable middle ground for a first pass.
const LIVE_TAU = 0.45
const LIVE_CLOCK_INTERVAL_MS = 500

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
  /** How bottom-heavy the word sounded, in dB — the nasality evidence. See spectral.ts. */
  nasalDb: number | null
  /** The centre of gravity of the word's F2 region, in Hz, which tracks how far back the
   * tongue sat. Reported only: telling tafkhīm from tarqīq by it would need to know which
   * *letter* each frame belongs to, and word-level alignment does not. See the note in
   * applyResult. */
  centroidHz: number | null
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
  fillRef,
}: {
  words: WordWithRules[]
  liveWords: LiveWordResult[]
  /** What the word being recited right now has been held for, what its rules require, and
   * what they merely permit beyond that. Null between words. Used for the *layout* of the
   * meter — where the finish line sits, how much optional track to draw — all of which only
   * changes when the word does. */
  holdProgress: { voicedMs: number; requiredMs: number; optionalMs: number } | null
  /** The filled part of the meter, handed back to the caller so its animation-frame loop can
   * set the width directly. Going through React state moved it at best every 80ms and, worse,
   * re-rendered this whole list to do it — which starved the frames feeding the tracker and
   * left the bar visibly trailing the voice. */
  fillRef?: (el: HTMLSpanElement | null) => void
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
                  ref={fillRef}
                  className={clsx('absolute inset-y-0 right-0 rounded-full', complete ? 'bg-ok' : 'bg-gold')}
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
        // A word that owed a hold and did not deliver it is named, not merely coloured —
        // "أقصر من المتوقع" tells a reciter nothing they can act on, while "لم تكتمل الغُنّة"
        // does. Timing evidence only: it fires when the word had no room for the hold.
        if (live.missed) {
          const ruleName = TAJWEED_RULE_MAP[live.missed.rule]?.nameAr ?? (live.missed.kind === 'ghunnah' ? 'الغُنّة' : 'المدّ')
          const severe = live.missed.severity === 'severe'
          return (
            <span key={i} className="relative inline-block px-1.5 pb-4 pt-0.5">
              <span
                className={clsx(
                  'rounded-lg px-1 ring-1',
                  severe ? 'bg-danger-soft text-danger ring-danger/50' : 'bg-warn-soft text-warn ring-warn/50',
                )}
              >
                {w.word}
              </span>
              <span
                className={clsx(
                  'absolute inset-x-0 bottom-0 truncate text-center font-sans text-[9px] font-bold leading-none',
                  severe ? 'text-danger' : 'text-warn',
                )}
              >
                {severe ? `${ruleName} لم يظهر` : `${ruleName} لم يكتمل`}
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
  preparing = false,
  micLevel,
  elapsedMs,
  onStart,
  onStop,
  ringRef,
}: {
  recording: boolean
  busy: boolean
  /** The model is still downloading. The button stays visible but cannot be pressed yet —
   * a disabled control that explains itself beats a screen that hides the whole feature. */
  preparing?: boolean
  /** Only for the "too quiet" warning, which is read rather than watched. The ring itself is
   * sized from the animation-frame loop through `ringRef`, so it tracks the voice directly
   * instead of at whatever rate the page happens to re-render. */
  micLevel: number
  elapsedMs: number
  onStart: () => void
  onStop: () => void
  ringRef?: (el: HTMLSpanElement | null) => void
}) {
  const level = Math.min(1, Math.max(0, micLevel))
  const quiet = recording && elapsedMs > 1500 && level < 0.08

  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="relative flex h-28 w-28 items-center justify-center">
        {recording && (
          <>
            <span
              ref={ringRef}
              aria-hidden
              className="absolute rounded-full bg-danger/20"
              style={{ width: `${72 + level * 44}px`, height: `${72 + level * 44}px` }}
            />
            <span aria-hidden className="absolute h-[84px] w-[84px] animate-ping rounded-full bg-danger/15" />
          </>
        )}
        <button
          onClick={recording ? onStop : onStart}
          disabled={busy || preparing}
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
          <span className="text-sm font-semibold text-muted">
            {preparing ? 'لحظة — يُجهَّز التعرّف الصوتي' : 'اضغط لبدء التسجيل'}
          </span>
        )}
      </div>
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
  const [nasalityAlerts, setNasalityAlerts] = useState<NasalityAlert[]>([])
  /**
   * The pace being recited in. It is not a preference about strictness — it decides what the
   * rules actually require, since the ʿāriḍ is two ḥarakāt in ḥadr and six in taḥqīq. Kept
   * across visits because a reciter's pace is a habit, not a per-session choice.
   */
  const [paceId, setPaceId] = useState<PaceId>(() => {
    try {
      const stored = localStorage.getItem('wartil-pace')
      if (stored && PACES.some((p) => p.id === stored)) return stored as PaceId
    } catch {
      // Private mode or blocked storage — the default is fine.
    }
    return DEFAULT_PACE_ID
  })
  /** What the reciter actually did, as opposed to what they selected. */
  const [recitedPace, setRecitedPace] = useState<{ pace: PaceProfile; harakaMs: number; matchesSelected: boolean } | null>(
    null,
  )
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  /** The most recent rule the reciter passed over, shown while they are still reading. */
  const [liveMiss, setLiveMiss] = useState<
    { index: number; rule: TajweedRuleId; kind: 'madd' | 'ghunnah'; severity: 'mild' | 'severe'; at: number } | null
  >(null)
  useEffect(() => {
    try {
      localStorage.setItem('wartil-pace', paceId)
    } catch {
      // Not worth surfacing: the choice simply will not be remembered next visit.
    }
  }, [paceId])

  /** The filled part of the live hold meter, written to directly each animation frame. */
  const holdFillRef = useRef<HTMLSpanElement | null>(null)
  /** The tracker revision the last React render reflected, so renders happen on events. */
  const liveRevisionRef = useRef(-1)
  /** The mic ring, likewise driven per frame rather than through a re-render. */
  const micRingRef = useRef<HTMLSpanElement | null>(null)
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

  /**
   * Start fetching the model the moment the page opens.
   *
   * It used to sit behind a button explaining Web Workers and one-time downloads, which
   * asks a reciter to understand the app's architecture before they can recite a word. The
   * download is still the same size and still happens once; it simply happens while they are
   * choosing a surah instead of after. The recorder below shows its own progress, so nothing
   * about the wait is hidden — only the decision they had no basis to make.
   */
  useEffect(() => {
    whisper.load()
    // `load` no-ops once loading or ready, so a re-run cannot start a second worker.
  }, [whisper.load])

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
      nasalityAlerts,
    })
  }, [wordVerdicts, referenceWords, acousticAlerts, qalqalahAlerts, nasalityAlerts])

  function resetResult() {
    setAligned(null)
    setWordConfidences(null)
    setAcousticAlerts([])
    setQalqalahAlerts([])
    setNasalityAlerts([])
    setRecitedPace(null)
    setLiveMiss(null)
    setHypothesis(null)
    setLiveSnapshot(null)
    setPassageMatch(0)
    setDiagnostics([])
    setOrthographyVariant(null)
    liveTrackerRef.current = null
    liveRevisionRef.current = -1
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

    // What the words actually *sounded* like, as opposed to how long they took. This is the
    // only evidence that can settle a ghunnah on a short word: two ḥarakāt of nasal sound
    // fit inside the error in the word boundaries themselves, so «عَمَّ» recited without one
    // is, to a clock, a fast «عَمَّ» recited with one. See spectral.ts and nasality.ts.
    const timbre = resultTimings ? measureWordTimbre(audioForAnalysis, TARGET_SAMPLE_RATE, resultTimings) : []

    // The raw numbers behind every verdict. The thresholds these feed are reasoned rather
    // than measured — there is no corpus of real recitations to calibrate them against — so
    // the panel that shows this is how a real attempt on a real device gets turned into
    // evidence for tuning them.
    setDiagnostics(
      referenceWords.map((refWord, i) => {
        const timing = resultTimings?.[i] ?? null
        const expected = expectedDurationBreakdown(refWord, paceId)
        return {
          refIndex: i,
          word: refWord.word,
          confidence: resultConfidences?.[i] ?? null,
          freeStatus: verdicts[i]?.freeStatus ?? null,
          measuredMs: timing ? Math.round((timing[1] - timing[0]) * 1000) : null,
          expectedMs: expected.total,
          expectedWithoutMaddMs: expected.withoutMadd,
          nasalDb: timbre[i]?.peakNasalDb ?? null,
          centroidHz: timbre[i]?.centroidHz ?? null,
        }
      }),
    )
    const correctRefIndices = new Set(verdicts.filter((v) => v.status === 'correct').map((v) => v.refIndex))

    // Forced-alignment timing (precise, from the known text) is preferred; fall back to
    // the free decode's approximate word timestamps when it isn't available this time.
    const acoustic = resultTimings
      ? detectMaddDurationAlertsForced(referenceWords, resultTimings, correctRefIndices, paceId)
      : detectMaddDurationAlertsFromFreeDecode(result, referenceWords, collapsed.chunks, correctRefIndices, paceId)
    // What the reciter actually read in, whatever they selected — reported back rather than
    // silently graded against the wrong yardstick.
    setRecitedPace(resultTimings ? detectRecitedPace(referenceWords, resultTimings, correctRefIndices, paceId) : null)
    const qalqalah = resultTimings ? detectQalqalahIssues(audioForAnalysis, referenceWords, resultTimings, correctRefIndices) : []
    // Judged against this reciter's own non-nasal words in this same recording — absolute
    // levels say nothing across microphones and voices.
    const nasality = detectGhunnahNasalityAlerts(referenceWords, timbre, correctRefIndices)
    setAcousticAlerts(acoustic)
    setQalqalahAlerts(qalqalah)
    setNasalityAlerts(nasality)

    if (verdicts.some((v) => v.status === 'wrong') || acoustic.length > 0 || qalqalah.length > 0 || nasality.length > 0) {
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
      const tracker = new LiveTajweedTracker(
        referenceWords,
        LIVE_TAU,
        (index, result) => {
          // A dropped rule gets its own pattern and its own banner: it is the thing worth
          // interrupting for, and it is what someone deliberately skipping a rule is
          // waiting to see the app notice.
          if (result.missed) {
            vibrate(result.missed.severity === 'severe' ? [120, 60, 120, 60, 120] : [90, 50, 90])
            setLiveMiss({ index, ...result.missed, at: performance.now() })
          } else if (result.status === 'silent') vibrate([100, 50, 100])
          else if (result.status === 'short' || result.status === 'long') vibrate(60)
        },
        paceId,
      )
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
          // One loop does everything that has to keep up with the voice: read the level,
          // feed the tracker, and paint the two things that move continuously — the hold
          // meter and the mic ring — straight onto their DOM nodes.
          //
          // Painting them through React state on an 80ms timer was what made the meter lag.
          // Not only was 80ms plus a 100ms width transition already ~180ms behind the voice;
          // re-rendering the whole passage twelve times a second on a phone starved the very
          // animation frames that feed the tracker, so the frame deltas grew and the
          // measurements themselves arrived late and coarse. React now re-renders only when
          // the tracker says something discrete happened — a word opened or closed.
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

            const hold = tr.currentHold()
            const fill = holdFillRef.current
            if (fill && hold) {
              const span = hold.requiredMs + hold.optionalMs
              fill.style.width = span > 0 ? `${Math.min(100, (hold.voicedMs / span) * 100)}%` : '0%'
            }

            const ring = micRingRef.current
            if (ring) {
              // Speech RMS sits well below 1, so scale it into a usable 0–1 meter range.
              const level = Math.min(1, rms * 12)
              const size = `${72 + level * 44}px`
              ring.style.width = size
              ring.style.height = size
            }

            if (tr.revision() !== liveRevisionRef.current) {
              liveRevisionRef.current = tr.revision()
              setLiveSnapshot(tr.snapshot())
            }
            rafIdRef.current = requestAnimationFrame(feedLoop)
          }
          rafIdRef.current = requestAnimationFrame(feedLoop)

          // Only the things a person reads rather than watches: the clock, and whether the
          // recording is too quiet to hear. Once a second is plenty for both.
          snapshotIntervalRef.current = window.setInterval(() => {
            setMicLevel(Math.min(1, latestRmsRef.current * 12))
            setElapsedMs(performance.now() - startedAtRef.current)
          }, LIVE_CLOCK_INTERVAL_MS)
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

      <div className="card-lux space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1.5 block text-xs font-bold text-faint">السورة</span>
            <Dropdown
              label="السورة"
              value={surahNumber}
              onChange={setSurahNumber}
              options={surahs.map((s) => ({ value: s.number, label: `${s.number}. ${s.name}` }))}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1.5 block text-xs font-bold text-faint">من آية</span>
            <Dropdown
              label="من آية"
              value={fromAyah}
              onChange={handleFromChange}
              options={ayahOptions.map((n) => ({ value: n, label: String(n) }))}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1.5 block text-xs font-bold text-faint">إلى آية</span>
            <Dropdown
              label="إلى آية"
              value={toAyah}
              onChange={handleToChange}
              options={ayahOptions.map((n) => ({ value: n, label: String(n) }))}
            />
          </label>
        </div>

        <div className="hair-gold" />

        {/* The pace is not a difficulty setting. It decides what the rules require: the madd
            ʿāriḍ is two ḥarakāt in ḥadr and six in taḥqīq, and all three readings are sound. */}
        <div>
          <span className="mb-2 block text-xs font-bold text-faint">مرتبة التلاوة</span>
          <div className="grid grid-cols-3 gap-2">
            {PACES.map((p) => {
              const active = p.id === paceId
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPaceId(p.id)}
                  aria-pressed={active}
                  className={clsx(
                    'rounded-xl border px-2 py-2.5 text-center transition',
                    active
                      ? 'border-gold bg-accent-soft text-accent shadow-sm'
                      : 'border-line bg-elevated text-muted hover:border-gold/50',
                  )}
                >
                  <span className="block font-display text-sm font-bold">{p.nameAr}</span>
                  <span className="mt-0.5 block text-[10px] leading-tight opacity-80">{p.taglineAr}</span>
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-faint">{paceOf(paceId).descriptionAr}</p>
        </div>
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

            {/* Named the moment it happens, while the reciter can still act on it. */}
            {recording && liveMiss && (
              <div
                key={`${liveMiss.index}-${liveMiss.at}`}
                className={clsx(
                  'mb-3 flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm font-bold animate-[fadeIn_0.2s_ease]',
                  liveMiss.severity === 'severe'
                    ? 'border-danger/50 bg-danger-soft text-danger'
                    : 'border-warn/50 bg-warn-soft text-warn',
                )}
                role="status"
              >
                <span aria-hidden className="text-base">
                  {liveMiss.kind === 'ghunnah' ? '👃' : '〰️'}
                </span>
                <span>
                  {TAJWEED_RULE_MAP[liveMiss.rule]?.nameAr ?? 'الحكم'} في{' '}
                  <span className="font-quran text-base">«{referenceWords[liveMiss.index]?.word ?? ''}»</span>{' '}
                  {liveMiss.severity === 'severe' ? 'مرّت بلا أداء — أعِدها' : 'لم تكتمل — أعطها حقّها'}
                </span>
              </div>
            )}

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
                          fillRef={(el) => {
                            holdFillRef.current = el
                          }}
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
        {/* The model loads by itself on arrival, so this is a status line rather than a gate:
            the recorder is always visible, and simply waits until it can be used. */}
        {whisper.status === 'loading' && (
          <div className="mb-5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-line-soft">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${Math.max(4, whisper.progress)}%`,
                  background: 'linear-gradient(90deg, var(--c-gold-deep), var(--c-gold), var(--c-gold-soft))',
                }}
              />
            </div>
            <p className="mt-2 text-center text-xs font-bold text-faint">
              جارٍ تجهيز التعرّف الصوتي… {Math.round(whisper.progress)}٪ — يحدث مرة واحدة فقط
            </p>
          </div>
        )}

        {whisper.status === 'error' && (
          <div className="mb-5">
            <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-bold text-danger">
              تعذّر تجهيز التعرّف الصوتي ({whisper.error ?? 'خطأ غير معروف'}). تحقّق من اتصالك بالإنترنت.
            </p>
            <button onClick={whisper.load} className="btn-accent mt-3 w-full">
              إعادة المحاولة
            </button>
          </div>
        )}

        {whisper.status !== 'error' && (
          <div className="space-y-4">
            <Recorder
              recording={recording}
              busy={busy}
              preparing={whisper.status !== 'ready'}
              micLevel={micLevel}
              elapsedMs={elapsedMs}
              onStart={startRecording}
              onStop={stopRecording}
              ringRef={(el) => {
                micRingRef.current = el
              }}
            />
            {micError && <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-bold text-danger">{micError}</p>}
          </div>
        )}
      </div>

      {wordVerdicts && score && (
        <div className="card-lux space-y-6 p-6">
          {/* A score is only shown when what was heard is actually this passage. Reciting
              something else entirely used to print a confident percentage next to a note
              saying that percentage could not be trusted — a number on screen wins that
              argument every time, so there is now no number to win it with. */}
          {passageMatch < PASSAGE_MATCH_FLOOR ? (
            <div className="rounded-xl border border-warn/40 bg-warn-soft px-4 py-4">
              <p className="font-display text-base font-bold text-warn">لم نتعرّف على هذا المقطع</p>
              <p className="mt-1.5 text-sm font-semibold leading-relaxed text-warn">
                ما سُمع لا يطابق الآيات المحدّدة، فلا يمكن إعطاء نتيجة. تأكّد أنك تقرأ المقطع المختار، وأن الميكروفون
                قريب وواضح، ثم أعد المحاولة.
              </p>
            </div>
          ) : (
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
          )}

          {/* Which pace was actually read in. Naming it is half the teaching: a reciter who
              selected taḥqīq and read in ḥadr has not made a mistake, they have read a
              different — and equally sound — mode, and should be told so rather than marked
              down against madds they never owed. */}
          {recitedPace && passageMatch >= PASSAGE_MATCH_FLOOR && (
            <div
              className={clsx(
                'rounded-xl border px-4 py-3 text-sm leading-relaxed',
                recitedPace.matchesSelected ? 'border-ok/40 bg-ok/10 text-ok' : 'border-info/40 bg-info-soft text-info',
              )}
            >
              {recitedPace.matchesSelected ? (
                <>
                  قرأتَ بمرتبة <span className="font-display font-bold">{recitedPace.pace.nameAr}</span> — وهي المرتبة
                  التي اخترتها، فقد قُيّست أحكامك على مقاديرها.
                </>
              ) : (
                <>
                  قرأتَ فعليًا بمرتبة <span className="font-display font-bold">{recitedPace.pace.nameAr}</span>، بينما
                  اخترتَ <span className="font-display font-bold">{paceOf(paceId).nameAr}</span>. وكلتاهما صحيحة، لكن
                  المقادير تختلف بينهما — اختر <span className="font-bold">{recitedPace.pace.nameAr}</span> ليُقاس مدّك
                  على ما قرأتَ به فعلًا.
                </>
              )}
            </div>
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

          {nasalityAlerts.length > 0 && (
            <div>
              <h3 className="mb-3 font-display text-base font-bold text-ghunnah">👃 تنبيهات صوتية تجريبية (الغُنّة)</h3>
              <ul className="space-y-2.5">
                {nasalityAlerts.map((a) => (
                  <li
                    key={a.refIndex}
                    className="rounded-xl border border-ghunnah/40 bg-ghunnah-soft p-3.5 text-sm leading-relaxed text-ghunnah"
                  >
                    {a.severity === 'severe' ? (
                      <>
                        كلمة <span className="font-quran font-bold">«{a.word}»</span> فيها{' '}
                        {TAJWEED_RULE_MAP[a.rule].nameAr}، لكن صوتها خرج من الفم وحده — لم يظهر فيها رنين الخيشوم
                        مقارنةً ببقية كلماتك في هذا التسجيل.
                      </>
                    ) : (
                      <>
                        رنين الخيشوم في <span className="font-quran font-bold">«{a.word}»</span> جاء خافتًا بالنسبة
                        لبقية قراءتك — {TAJWEED_RULE_MAP[a.rule].nameAr} يحتاج غُنّة أوضح.
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

          {/* The raw measurements are for whoever is tuning the thresholds, not for a reciter.
              Left open to everyone it was simply a wall of numbers with no reading of them;
              it now stays out of the way unless asked for, and says plainly who it is for. */}
          {diagnostics.length > 0 && showDiagnostics && (
            <details className="rounded-xl border border-line-soft bg-bg/40">
              <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-muted">
                🔬 القياسات الخام (للمطوّرين — لضبط حساسية التحليل)
              </summary>
              <div className="overflow-x-auto px-4 pb-4">
                <p className="mb-3 text-xs leading-relaxed text-faint">
                  تطابق المقطع ككل: {Math.round(passageMatch * 100)}% · رسم النص المعتمد للمطابقة الصوتية:{' '}
                  {orthographyVariant ?? 'غير متاح'} · إشارة الثقة:{' '}
                  {isConfidenceUsable(wordConfidences) ? 'صالحة' : 'مهمَلة (مسطّحة قرب الصفر)'}. «الثقة» احتمال النموذج
                  للكلمة، و«المقيس/المتوقع» زمنها بالملي ثانية. و«الغُنّة» رجحان
                  الطاقة في الترددات المنخفضة بالديسيبل — يُقارَن بكلماتك غير الأنفية في التسجيل نفسه، لا بقيمة
                  مطلقة. و«مركز F2» موضع اللسان بالهرتز: يُعرَض للاطّلاع فقط، لأنّ الحكم به على التفخيم والترقيق
                  يحتاج محاذاة على مستوى الحرف لا الكلمة.
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
                      <th className="pb-1.5 font-bold">الغُنّة</th>
                      <th className="pb-1.5 font-bold">مركز F2</th>
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
                        <td className="py-1.5">{d.nasalDb === null ? '—' : d.nasalDb.toFixed(1)}</td>
                        <td className="py-1.5">{d.centroidHz === null ? '—' : Math.round(d.centroidHz)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {diagnostics.length > 0 && (
            <button
              type="button"
              onClick={() => setShowDiagnostics((v) => !v)}
              className="text-xs font-bold text-faint underline decoration-dotted underline-offset-4 transition hover:text-muted"
            >
              {showDiagnostics ? 'إخفاء القياسات الخام' : 'عرض القياسات الخام (للمطوّرين)'}
            </button>
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
