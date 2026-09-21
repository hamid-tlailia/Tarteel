import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchSurahAyahs, fetchSurahList } from '../api/quran'
import type { Ayah, SurahMeta } from '../types/quran'
import { TajweedText } from '../components/TajweedText'
import { TajweedLegend } from '../components/TajweedLegend'

export function QuranPage() {
  const { surahNumber } = useParams<{ surahNumber: string }>()
  const navigate = useNavigate()
  const selected = surahNumber ? Number(surahNumber) : null

  const [surahs, setSurahs] = useState<SurahMeta[]>([])
  const [ayahs, setAyahs] = useState<Ayah[]>([])
  const [loading, setLoading] = useState(false)
  const [colored, setColored] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playingAyah, setPlayingAyah] = useState<number | null>(null)

  useEffect(() => {
    fetchSurahList()
      .then(setSurahs)
      .catch(() => setError('تعذّر تحميل قائمة السور، تحقق من اتصالك بالإنترنت.'))
  }, [])

  useEffect(() => {
    if (!selected) return
    setLoading(true)
    setError(null)
    fetchSurahAyahs(selected)
      .then(setAyahs)
      .catch(() => setError('تعذّر تحميل نص السورة.'))
      .finally(() => setLoading(false))
  }, [selected])

  const playAyah = (ayah: Ayah) => {
    if (!audioRef.current) return
    if (playingAyah === ayah.number) {
      audioRef.current.pause()
      setPlayingAyah(null)
      return
    }
    audioRef.current.src = ayah.audioUrl
    audioRef.current.play()
    setPlayingAyah(ayah.number)
  }

  if (!selected) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-gilded font-display text-3xl font-bold">المصحف الملوّن</h1>
          <p className="mt-2 text-sm text-muted">اختر سورة لعرضها بألوان أحكام التجويد مع تلاوة الشيخ العفاسي.</p>
          <div className="hair-gold mt-4 max-w-sm" />
        </div>
        {error && <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-bold text-danger">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {surahs.map((s) => (
            <button
              key={s.number}
              onClick={() => navigate(`/quran/${s.number}`)}
              className="card-lux card-hover group flex items-center justify-between gap-3 px-4 py-3.5 text-right"
            >
              <span className="flex items-center gap-3.5">
                <span aria-hidden className="relative flex h-11 w-11 items-center justify-center text-gold">
                  <span className="absolute inset-0 rotate-45 rounded-[10px] border border-gold/50 bg-accent-soft/60 transition-transform duration-300 group-hover:rotate-[135deg]" />
                  <span className="relative font-display text-sm font-bold">{s.number}</span>
                </span>
                <span>
                  <span className="block font-display text-lg font-bold leading-snug text-ink transition-colors group-hover:text-accent">
                    {s.name}
                  </span>
                  <span className="block text-[11px] font-medium text-faint">
                    {s.englishNameTranslation} · {s.numberOfAyahs} آية · {s.revelationType === 'Meccan' ? 'مكية' : 'مدنية'}
                  </span>
                </span>
              </span>
              <span aria-hidden className="text-lg text-gold/60 transition group-hover:text-gold">
                ﴿
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const meta = surahs.find((s) => s.number === selected)

  return (
    <div className="space-y-7">
      <button
        onClick={() => navigate('/quran')}
        className="inline-flex items-center gap-1.5 text-sm font-bold text-accent transition hover:text-gold"
      >
        <span aria-hidden>→</span> جميع السور
      </button>

      <div className="card-lux pattern-panel relative flex flex-wrap items-center justify-between gap-4 overflow-hidden p-5 sm:p-6">
        <div className="relative text-center">
          <h1 className="font-display text-3xl font-bold text-ink">{meta ? meta.name : `سورة ${selected}`}</h1>
          {meta && (
            <p className="mt-1 text-xs font-medium text-faint">
              {meta.revelationType === 'Meccan' ? 'مكية' : 'مدنية'} · {meta.numberOfAyahs} آية
            </p>
          )}
        </div>
        <label className="relative flex cursor-pointer items-center gap-2.5 rounded-full border border-line bg-elevated/70 px-4 py-2 text-sm font-bold text-muted transition hover:border-gold/60">
          <input
            type="checkbox"
            checked={colored}
            onChange={(e) => setColored(e.target.checked)}
            className="h-4 w-4 accent-[var(--c-gold)]"
          />
          تلوين أحكام التجويد
        </label>
      </div>

      {colored && (
        <div className="card-lux p-4">
          <p className="title-ornament mb-3 font-display text-sm font-bold text-gold">دليل الألوان — اضغط على أي كلمة ملوّنة لمعرفة حكمها</p>
          <TajweedLegend compact />
        </div>
      )}

      {error && <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-bold text-danger">{error}</p>}
      {loading && (
        <div className="flex items-center justify-center gap-3 py-10 text-muted">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-gold border-t-transparent" aria-hidden />
          جاري التحميل…
        </div>
      )}

      <div className="space-y-5">
        {ayahs.map((ayah) => (
          <div key={ayah.number} className="ayah-frame group flex items-start gap-3 p-5 transition-shadow hover:shadow-[var(--shadow-lux)]">
            <button
              onClick={() => playAyah(ayah)}
              className="mt-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gold/50 bg-accent-soft text-accent shadow-sm transition hover:scale-105 hover:border-gold hover:text-gold"
              aria-label={playingAyah === ayah.number ? 'إيقاف الاستماع' : 'استماع'}
            >
              <span className="text-sm">{playingAyah === ayah.number ? '❚❚' : '▶'}</span>
            </button>
            <div className="flex-1">
              <TajweedText segments={ayah.segments} colored={colored} className="font-quran text-2xl" />
              <span
                aria-label={`الآية ${ayah.numberInSurah}`}
                className="relative mr-2 inline-flex h-7 w-7 items-center justify-center align-middle text-[10px] font-black text-gold"
              >
                <span aria-hidden className="absolute inset-0 rotate-45 rounded-[6px] border border-gold/60 bg-accent-soft/50" />
                <span className="relative">{ayah.numberInSurah}</span>
              </span>
            </div>
          </div>
        ))}
      </div>

      <audio ref={audioRef} onEnded={() => setPlayingAyah(null)} className="hidden" />
    </div>
  )
}
