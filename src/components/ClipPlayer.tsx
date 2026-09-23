import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

/**
 * Hearing yourself back, and hearing one word back.
 *
 * A reciter told that the madd in «يَتَسَآءَلُونَ» was short has been given a claim about a
 * sound they can no longer hear. Written advice about a sound is the weakest form of teaching
 * there is: the learner has to take it on faith, cannot check it, and cannot hear the
 * difference between what they did and what was asked. The recording is right there — the
 * analysis was made on it — so this plays it, and plays any single word or ayah of it, from the
 * timings the analysis already produced.
 */

const PAD_MS = 120

export interface ClipPlayer {
  /** Plays a span of the recording, in seconds. */
  playRange: (from: number, to: number) => void
  playAll: () => void
  stop: () => void
  playing: boolean
  /** Which span is being played, so the caller can mark it. */
  activeRange: [number, number] | null
  rate: number
  setRate: (rate: number) => void
  ready: boolean
  /** The recording itself, so a page can offer a plain browser player as well. */
  url: string | null
  /** Why nothing was heard, when nothing was heard. */
  error: string | null
}

export function useClipPlayer(url: string | null): ClipPlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stopAtRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [activeRange, setActiveRange] = useState<[number, number] | null>(null)
  const [rate, setRate] = useState(1)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!url) {
      audioRef.current = null
      setReady(false)
      return
    }
    const audio = new Audio(url)
    audio.preload = 'auto'
    // Without this the element may sit at readyState 0 until something asks it to play, and
    // seeking a media element that has no metadata yet throws — which is exactly what happened:
    // pressing «اسمع تلاوتك» set currentTime first, the assignment threw inside the click
    // handler, and play() was never reached. Nothing played and nothing said why.
    audio.load()
    audioRef.current = audio
    setError(null)
    setReady(true)
    const onError = () =>
      setError(`تعذّر تشغيل التسجيل (${audio.error?.code ?? '?'}) — جرّب مشغّل المتصفح أدناه.`)
    audio.addEventListener('error', onError)
    // The element is polled rather than driven by 'timeupdate', which fires only about four
    // times a second — far too coarse to stop cleanly at the end of a single word.
    let raf = 0
    const tick = () => {
      const stopAt = stopAtRef.current
      if (stopAt !== null && audio.currentTime >= stopAt) {
        audio.pause()
        stopAtRef.current = null
        setPlaying(false)
        setActiveRange(null)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const onEnded = () => {
      setPlaying(false)
      setActiveRange(null)
    }
    audio.addEventListener('ended', onEnded)
    return () => {
      cancelAnimationFrame(raf)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
      audio.pause()
      audioRef.current = null
      setReady(false)
    }
  }, [url])

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [rate])

  /**
   * Starts playback at a position, waiting for the element to be seekable first.
   *
   * A media element cannot be seeked before it has metadata — the assignment throws — and a
   * blob URL is not necessarily ready the instant it is created. So the seek is deferred to
   * `loadedmetadata` when it has to be, and every failure is reported rather than swallowed:
   * the first version called `void audio.play()` and discarded the rejected promise, so a
   * recording that would not play looked exactly like one that played silently.
   */
  const startAt = useCallback(
    (from: number, stopAt: number | null, range: [number, number] | null) => {
      const audio = audioRef.current
      if (!audio) return
      const begin = () => {
        try {
          audio.currentTime = from
        } catch {
          // Seeking failed; playing from the top is better than playing nothing.
        }
        audio.playbackRate = rate
        audio
          .play()
          .then(() => {
            setError(null)
            setPlaying(true)
            setActiveRange(range)
          })
          .catch((err: unknown) => {
            setPlaying(false)
            setActiveRange(null)
            setError(`تعذّر تشغيل التسجيل: ${(err as Error).message} — جرّب مشغّل المتصفح أدناه.`)
          })
      }
      stopAtRef.current = stopAt
      if (audio.readyState >= 1) begin()
      else audio.addEventListener('loadedmetadata', begin, { once: true })
    },
    [rate],
  )

  const playRange = useCallback(
    (from: number, to: number) => {
      // A word clipped exactly at its boundaries starts mid-sound; a little air either side
      // makes it recognisable as the word it is.
      startAt(Math.max(0, from - PAD_MS / 1000), to + PAD_MS / 1000, [from, to])
    },
    [startAt],
  )

  const playAll = useCallback(() => startAt(0, null, null), [startAt])

  const stop = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    stopAtRef.current = null
    setPlaying(false)
    setActiveRange(null)
  }, [])

  return { playRange, playAll, stop, playing, activeRange, rate, setRate, ready, url, error }
}

/** A blob URL for the samples just recorded, revoked when it is replaced. */
export function useWavUrl(wav: Uint8Array | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!wav) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(new Blob([wav as unknown as BlobPart], { type: 'audio/wav' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [wav])
  return url
}

/** The transport for the whole attempt: play, stop, and slow it down to listen closely. */
export function PlayerBar({
  player,
  referenceUrl,
  reciterName,
}: {
  player: ClipPlayer
  /** The accredited reciter's own recording of the same passage, when one is to hand. */
  referenceUrl?: string | null
  reciterName?: string
}) {
  const referenceAudio = useMemo(() => (referenceUrl ? new Audio(referenceUrl) : null), [referenceUrl])
  useEffect(() => () => referenceAudio?.pause(), [referenceAudio])
  if (!player.ready) return null

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-bg/40 p-3">
      <button
        type="button"
        onClick={() => (player.playing ? player.stop() : player.playAll())}
        className="btn-accent flex items-center gap-2 px-4 py-2 text-sm"
      >
        <span aria-hidden>{player.playing ? '⏸' : '▶'}</span>
        {player.playing ? 'إيقاف' : 'اسمع تلاوتك'}
      </button>
      {referenceAudio && (
        <button
          type="button"
          onClick={() => {
            player.stop()
            referenceAudio.currentTime = 0
            void referenceAudio.play()
          }}
          className="btn-ghost flex items-center gap-2 px-4 py-2 text-sm"
        >
          <span aria-hidden>🎧</span>
          {reciterName ? `اسمع ${reciterName}` : 'اسمع المرجع'}
        </button>
      )}
      <div className="flex items-center gap-1 text-xs font-bold text-faint">
        <span>السرعة</span>
        {[0.5, 0.75, 1].map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => player.setRate(r)}
            aria-pressed={player.rate === r}
            className={clsx(
              'rounded-lg border px-2 py-1 transition',
              player.rate === r ? 'border-gold bg-accent-soft text-accent' : 'border-line text-muted hover:border-gold/50',
            )}
          >
            {r === 1 ? '١×' : r === 0.75 ? '٠٫٧٥×' : '٠٫٥×'}
          </button>
        ))}
      </div>
      <span className="text-xs leading-relaxed text-faint">
        اضغط أي كلمة في المقارنة أدناه لسماع موضعها وحده.
      </span>
      {player.error && <p className="w-full text-xs font-bold text-warn">{player.error}</p>}
      {/* The browser's own player, always. If anything above fails — a codec, an autoplay
          policy, a device quirk — the learner can still hear the recording and still save it,
          which matters more than the buttons looking uniform. */}
      {player.url && (
        <audio controls src={player.url} className="mt-1 w-full" preload="metadata">
          تعذّر تشغيل الصوت في هذا المتصفح.
        </audio>
      )}
    </div>
  )
}
