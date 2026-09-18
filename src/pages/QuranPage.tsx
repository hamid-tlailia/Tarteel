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
      <div className="space-y-6">
        <h1 className="text-2xl font-black text-emerald-900 dark:text-brand-50">المصحف الملوّن</h1>
        {error && <p className="text-red-600">{error}</p>}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {surahs.map((s) => (
            <button
              key={s.number}
              onClick={() => navigate(`/quran/${s.number}`)}
              className="flex items-center justify-between rounded-xl border border-brand-200/70 bg-white/70 px-4 py-3 text-right shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-brand-900/50 dark:bg-white/5"
            >
              <span className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">
                  {s.number}
                </span>
                <span>
                  <span className="block font-quran text-lg font-bold text-emerald-900 dark:text-brand-50">{s.name}</span>
                  <span className="block text-xs text-emerald-900/50 dark:text-brand-100/50">
                    {s.englishNameTranslation} · {s.numberOfAyahs} آية
                  </span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const meta = surahs.find((s) => s.number === selected)

  return (
    <div className="space-y-6">
      <button onClick={() => navigate('/quran')} className="text-sm text-brand-700 hover:underline dark:text-brand-300">
        ← جميع السور
      </button>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-quran text-3xl font-bold text-emerald-900 dark:text-brand-50">
          {meta ? meta.name : `سورة ${selected}`}
        </h1>
        <label className="flex items-center gap-2 text-sm text-emerald-900/80 dark:text-brand-100/80">
          <input type="checkbox" checked={colored} onChange={(e) => setColored(e.target.checked)} className="accent-brand-600" />
          تلوين أحكام التجويد
        </label>
      </div>

      {colored && (
        <div className="rounded-xl border border-brand-200/60 bg-white/60 p-3 dark:border-brand-900/40 dark:bg-white/5">
          <TajweedLegend compact />
        </div>
      )}

      {error && <p className="text-red-600">{error}</p>}
      {loading && <p className="text-emerald-900/60 dark:text-brand-100/60">جاري التحميل…</p>}

      <div className="space-y-4">
        {ayahs.map((ayah) => (
          <div
            key={ayah.number}
            className="flex items-start gap-3 rounded-xl border border-brand-200/50 bg-white/50 p-4 dark:border-brand-900/40 dark:bg-white/5"
          >
            <button
              onClick={() => playAyah(ayah)}
              className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white shadow-sm transition hover:bg-brand-700"
              aria-label="استماع"
            >
              {playingAyah === ayah.number ? '❚❚' : '▶'}
            </button>
            <div className="flex-1">
              <TajweedText segments={ayah.segments} colored={colored} className="font-quran text-2xl" />
              <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-brand-300 text-[10px] font-bold text-brand-700 dark:border-brand-700 dark:text-brand-300">
                {ayah.numberInSurah}
              </span>
            </div>
          </div>
        ))}
      </div>

      <audio ref={audioRef} onEnded={() => setPlayingAyah(null)} className="hidden" />
    </div>
  )
}
