import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import clsx from 'clsx'
import { fetchSurahAyahs, fetchSurahList } from '../api/quran'
import type { Ayah, SurahMeta } from '../types/quran'
import { TajweedText } from '../components/TajweedText'
import { TajweedLegend } from '../components/TajweedLegend'
import { useProgressStore } from '../store/progressStore'

/** Arabic written without its diacritics, so a search for «الفاتحه» finds «ٱلْفَاتِحَة». */
function loose(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

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
  const [query, setQuery] = useState('')
  /** Repeat the ayah being played — how an ayah is actually memorised. */
  const [repeat, setRepeat] = useState(false)
  const [rate, setRate] = useState(1)
  const lastRead = useProgressStore((s) => s.lastRead)
  const setLastRead = useProgressStore((s) => s.setLastRead)

  const matches = useMemo(() => {
    const q = loose(query)
    if (!q) return surahs
    return surahs.filter(
      (s) =>
        String(s.number) === q ||
        loose(s.name).includes(q) ||
        s.englishName.toLowerCase().includes(q) ||
        s.englishNameTranslation.toLowerCase().includes(q),
    )
  }, [surahs, query])

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

  // «تابع القراءة» links to #ayah-N, which means nothing until the ayahs exist.
  useEffect(() => {
    if (ayahs.length === 0) return
    const target = window.location.hash.replace('#', '')
    if (!target) return
    document.getElementById(target)?.scrollIntoView({ block: 'center' })
  }, [ayahs])

  const playAyah = (ayah: Ayah) => {
    if (!audioRef.current) return
    if (playingAyah === ayah.number) {
      audioRef.current.pause()
      setPlayingAyah(null)
      return
    }
    audioRef.current.src = ayah.audioUrl
    audioRef.current.playbackRate = rate
    audioRef.current.loop = repeat
    void audioRef.current.play()
    setPlayingAyah(ayah.number)
    // Listening to an ayah is the clearest signal of where the reader is, so it doubles as the
    // bookmark — no one has to remember to press anything.
    setLastRead({ surah: ayah.surah, surahName: meta?.name ?? `سورة ${ayah.surah}`, ayah: ayah.numberInSurah, date: new Date().toISOString() })
  }

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = rate
      audioRef.current.loop = repeat
    }
  }, [rate, repeat])

  if (!selected) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-gilded font-display text-3xl font-bold">المصحف الملوّن</h1>
          <p className="mt-2 text-sm text-muted">اختر سورة لعرضها بألوان أحكام التجويد مع تلاوة الشيخ العفاسي.</p>
          <div className="hair-gold mt-4 max-w-sm" />
        </div>
        {error && <p className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm font-bold text-danger">{error}</p>}

        {/* Carrying on where the reader stopped, rather than making them find the place again. */}
        {lastRead && (
          <button
            onClick={() => navigate(`/quran/${lastRead.surah}#ayah-${lastRead.ayah}`)}
            className="card-lux card-hover flex w-full items-center justify-between gap-3 px-5 py-4 text-right"
          >
            <span>
              <span className="block font-display text-base font-bold text-accent">تابع القراءة</span>
              <span className="mt-0.5 block text-xs font-semibold text-faint">
                {lastRead.surahName} — الآية {lastRead.ayah}
              </span>
            </span>
            <span aria-hidden className="text-xl text-gold/70">
              ﴿
            </span>
          </button>
        )}

        <label className="block">
          <span className="mb-1.5 block text-xs font-bold text-faint">ابحث عن سورة</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="اسم السورة أو رقمها…"
            className="w-full rounded-xl border border-line bg-elevated px-4 py-2.5 text-sm text-ink outline-none transition focus:border-gold/70"
          />
        </label>
        {query && matches.length === 0 && (
          <p className="text-sm text-faint">لا توجد سورة بهذا الاسم أو الرقم.</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {matches.map((s) => (
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
        <div className="relative flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2.5 rounded-full border border-line bg-elevated/70 px-4 py-2 text-sm font-bold text-muted transition hover:border-gold/60">
            <input
              type="checkbox"
              checked={colored}
              onChange={(e) => setColored(e.target.checked)}
              className="h-4 w-4 accent-[var(--c-gold)]"
            />
            تلوين أحكام التجويد
          </label>
          {/* Repeating one ayah at a chosen speed is how an ayah is actually memorised, and how
              a ruling inside it becomes audible — both were missing. */}
          <button
            type="button"
            onClick={() => setRepeat((v) => !v)}
            aria-pressed={repeat}
            className={clsx(
              'rounded-full border px-4 py-2 text-sm font-bold transition',
              repeat ? 'border-gold bg-accent-soft text-accent' : 'border-line bg-elevated/70 text-muted hover:border-gold/60',
            )}
          >
            🔁 تكرار الآية
          </button>
          <div className="flex items-center gap-1 rounded-full border border-line bg-elevated/70 px-2 py-1.5 text-xs font-bold text-muted">
            <span className="px-1">السرعة</span>
            {[0.5, 0.75, 1].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRate(r)}
                aria-pressed={rate === r}
                className={clsx('rounded-lg px-2 py-1 transition', rate === r ? 'bg-accent-soft text-accent' : 'hover:text-accent')}
              >
                {r === 1 ? '١×' : r === 0.75 ? '٠٫٧٥×' : '٠٫٥×'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Moving on without going back to the index — a muṣḥaf is read in order. */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={selected <= 1}
          onClick={() => navigate(`/quran/${selected - 1}`)}
          className="btn-ghost px-4 py-2 text-sm disabled:opacity-40"
        >
          ← السورة السابقة
        </button>
        <button
          type="button"
          disabled={selected >= 114}
          onClick={() => navigate(`/quran/${selected + 1}`)}
          className="btn-ghost px-4 py-2 text-sm disabled:opacity-40"
        >
          السورة التالية →
        </button>
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
          <div
            key={ayah.number}
            id={`ayah-${ayah.numberInSurah}`}
            className={clsx(
              'ayah-frame group flex items-start gap-3 p-5 transition-shadow hover:shadow-[var(--shadow-lux)] scroll-mt-24',
              lastRead?.surah === selected && lastRead.ayah === ayah.numberInSurah && 'ring-1 ring-gold/60',
            )}
          >
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
