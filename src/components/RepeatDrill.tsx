import { useState } from 'react'
import clsx from 'clsx'
import { TajweedText } from './TajweedText'
import { useClipPlayer, useWavUrl } from './ClipPlayer'
import { encodeWav } from '../lib/attemptBundle'
import { conditionForAsr, decodeToPcm16k, MicRecorder, TARGET_SAMPLE_RATE, trimSilence } from '../asr/audio'
import {
  heldHarakatOf,
  judgeDrill,
  measureDrill,
  type DrillMeasurement,
  type DrillTarget,
  type DrillVerdict,
} from '../lib/lessonDrill'
import { paceOf, type PaceId } from '../lib/recitationPace'
import { TAJWEED_RULE_MAP } from '../lib/tajweed'

/**
 * Say it, then find out what you did.
 *
 * The lesson could explain a ruling and ask its name, which tests whether a definition was
 * remembered. This asks for the thing itself — one short word, recited once — and answers the
 * only question a phone can honestly answer about it: how long the sound was held. Everything
 * else about the word (its letters, its makhraj, whether it was even the right word) is beyond
 * this, and the wording says so rather than letting a green tick imply otherwise.
 */

const VERDICT_STYLE: Record<DrillVerdict, string> = {
  met: 'border-ok/50 bg-ok/10 text-ok',
  short: 'border-warn/50 bg-warn-soft text-warn',
  absent: 'border-severe/50 bg-severe-soft text-severe',
  undecided: 'border-line bg-bg/40 text-muted',
}

export function RepeatDrill({
  target,
  paceId,
  exampleAudioUrl,
}: {
  target: DrillTarget
  paceId: PaceId
  /** The reciter's own reading of the ayah this word came from, to listen to first. */
  exampleAudioUrl?: string
}) {
  const [recorder, setRecorder] = useState<MicRecorder | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wav, setWav] = useState<Uint8Array | null>(null)
  const [measurement, setMeasurement] = useState<DrillMeasurement | null>(null)
  const url = useWavUrl(wav)
  const player = useClipPlayer(url)
  const rule = TAJWEED_RULE_MAP[target.rule]
  /** What this ruling asks for at the learner's pace — known before anything is recorded, which
   * is the point: the learner should see the target before attempting it. */
  const requiredHarakat = heldHarakatOf(target.rule, paceId)
  const requiredMs = Math.round(requiredHarakat * paceOf(paceId).harakaMs)

  const start = async () => {
    setError(null)
    setMeasurement(null)
    setWav(null)
    try {
      const mic = new MicRecorder()
      await mic.start()
      setRecorder(mic)
    } catch {
      setError('تعذّر الوصول إلى الميكروفون. تأكد من منح الإذن للمتصفح.')
    }
  }

  const stop = async () => {
    if (!recorder) return
    setBusy(true)
    try {
      const blob = await recorder.stop()
      setRecorder(null)
      const pcm = await decodeToPcm16k(blob)
      const conditioned = conditionForAsr(pcm)
      const trimmed = trimSilence(conditioned.pcm)
      setWav(encodeWav(trimmed, TARGET_SAMPLE_RATE))
      setMeasurement(measureDrill(trimmed, TARGET_SAMPLE_RATE, target.rule, paceId))
    } catch (err) {
      setError((err as Error).message || 'تعذّر تحليل التسجيل.')
    } finally {
      setBusy(false)
    }
  }

  const judged = measurement ? judgeDrill(measurement) : null

  return (
    <section className="card-lux space-y-4 p-6">
      <div>
        <h2 className="title-ornament font-display text-xl font-bold text-accent">تمرين: انطقها بنفسك</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          استمع أولًا، ثم اقرأ هذه الكلمة وحدها. سنقيس <span className="font-bold">مدّة الصوت الممتدّ</span> فيها
          ونقارنها بما يطلبه {rule?.nameAr ?? 'الحكم'} — ولن نحكم على مخرج الحرف ولا على صحّة بقيّة الكلمة.
        </p>
      </div>

      <div className="ayah-frame flex flex-col items-center gap-2 p-5">
        <TajweedText segments={target.segments} className="font-quran text-4xl" interactive={false} />
        <span className="text-xs font-semibold text-faint">
          من سورة {target.surah} — الآية {target.ayah}
          {requiredHarakat > 0 && ` · المطلوب: ${requiredHarakat} حركات ≈ ${requiredMs} ملي ثانية`}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {exampleAudioUrl && (
          <>
            <button
              type="button"
              onClick={() => {
                const audio = new Audio(exampleAudioUrl)
                void audio.play()
              }}
              className="btn-ghost px-4 py-2 text-sm"
            >
              🎧 اسمع الآية
            </button>
            <button
              type="button"
              onClick={() => {
                const audio = new Audio(exampleAudioUrl)
                audio.playbackRate = 0.6
                void audio.play()
              }}
              className="btn-ghost px-4 py-2 text-sm"
            >
              🐢 اسمعها مُبطّأة
            </button>
          </>
        )}
        {recorder ? (
          <button type="button" onClick={stop} className="btn-accent px-4 py-2 text-sm">
            ⏹ أوقف وسجِّل النتيجة
          </button>
        ) : (
          <button type="button" onClick={start} disabled={busy} className="btn-accent px-4 py-2 text-sm disabled:opacity-60">
            {busy ? 'جارٍ القياس…' : '🎙 سجّل نطقك'}
          </button>
        )}
        {url && (
          <button type="button" onClick={() => (player.playing ? player.stop() : player.playAll())} className="btn-ghost px-4 py-2 text-sm">
            ▶ اسمع نفسك
          </button>
        )}
      </div>

      {error && <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-bold text-danger">{error}</p>}

      {measurement && judged && (
        <div className={clsx('rounded-xl border p-4 text-sm leading-relaxed', VERDICT_STYLE[judged.verdict])}>
          <p className="font-display text-base font-bold">
            {judged.verdict === 'met'
              ? '✓ أمسكتَ الصوت بالمقدار المطلوب'
              : judged.verdict === 'short'
                ? 'الصوت أقصر من المطلوب'
                : judged.verdict === 'absent'
                  ? 'لم يظهر إمساك للصوت'
                  : 'لم نستطع الحكم'}
          </p>
          <p className="mt-1.5">
            {judged.reasonAr ??
              `أمسكتَ ${measurement.harakat.toFixed(1)} حركة من ${measurement.requiredHarakat} مطلوبة (${measurement.heldMs} ملي ثانية).`}
          </p>
          {measurement.nasal !== null && measurement.requiredHarakat > 0 && (
            <p className="mt-1 text-xs opacity-90">
              {measurement.nasal ? 'وخرج الصوت من الخيشوم — وهذا ما تحتاجه الغُنّة.' : 'وخرج الصوت من الفم، لا من الخيشوم.'}
            </p>
          )}
          <p className="mt-2 border-t border-current/20 pt-2 text-xs opacity-80">
            هذا قياس لطول الصوت وحده. صحّة الحرف ومخرجه لا يقيسها التطبيق — اعرضها على معلّم.
          </p>
        </div>
      )}

      {url && <audio controls src={url} className="w-full" preload="metadata" />}
    </section>
  )
}
