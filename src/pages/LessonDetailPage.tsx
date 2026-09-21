import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { TAJWEED_RULES, TAJWEED_RULE_MAP } from '../lib/tajweed'
import type { TajweedRuleId } from '../types/quran'
import type { Ayah } from '../types/quran'
import { fetchExampleAyahsForRule } from '../api/quran'
import { TajweedText } from '../components/TajweedText'
import { useProgressStore } from '../store/progressStore'

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5)
}

export function LessonDetailPage() {
  const { ruleId } = useParams<{ ruleId: string }>()
  const rule = ruleId ? TAJWEED_RULE_MAP[ruleId as TajweedRuleId] : undefined
  const [examples, setExamples] = useState<Ayah[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const markComplete = useProgressStore((s) => s.markLessonComplete)
  const isComplete = useProgressStore((s) => (rule ? s.isLessonComplete(rule.id) : false))

  const choices = useMemo(() => {
    if (!rule) return []
    const distractors = shuffle(TAJWEED_RULES.filter((r) => r.id !== rule.id)).slice(0, 3)
    return shuffle([rule, ...distractors])
  }, [rule])

  useEffect(() => {
    if (!rule) return
    setLoading(true)
    setSelected(null)
    fetchExampleAyahsForRule(rule.id, 3)
      .then(setExamples)
      .catch(() => setExamples([]))
      .finally(() => setLoading(false))
  }, [rule])

  if (!rule) {
    return (
      <div className="card-lux p-8 text-center">
        <p className="text-ink">لم يتم العثور على هذا الحكم.</p>
        <Link to="/lessons" className="mt-3 inline-block font-bold text-accent underline decoration-gold underline-offset-4">
          العودة إلى الدروس
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <Link
        to="/lessons"
        className="inline-flex items-center gap-1.5 text-sm font-bold text-accent transition hover:text-gold"
      >
        <span aria-hidden>→</span> جميع الأحكام
      </Link>

      <header className="card-lux pattern-panel relative overflow-hidden p-7">
        <div className="relative">
          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-hidden
              className="flex h-11 w-11 items-center justify-center rounded-2xl ring-1 ring-inset ring-black/10"
              style={{ backgroundColor: rule.color, boxShadow: `0 0 22px color-mix(in srgb, ${rule.color} 40%, transparent)` }}
            />
            <div>
              <h1 className="font-display text-3xl font-bold text-ink">{rule.nameAr}</h1>
              <span className="text-xs font-medium tracking-wide text-faint">{rule.nameEn}</span>
            </div>
            {rule.durationAr && (
              <span className="mr-auto rounded-full border border-gold/50 bg-surface/70 px-3 py-1 text-xs font-bold text-gold">
                المقدار: {rule.durationAr}
              </span>
            )}
          </div>
          {rule.letters && (
            <div className="mt-5 rounded-xl border border-line-soft bg-bg/40 px-4 py-3 text-center">
              <span className="mr-2 text-xs font-bold text-faint">حروفه:</span>
              <span className="font-quran text-2xl" style={{ color: rule.color }}>
                {rule.letters}
              </span>
            </div>
          )}
          <p className="mt-5 text-[15px] leading-loose text-muted">{rule.description}</p>
        </div>
      </header>

      <section>
        <h2 className="title-ornament mb-4 font-display text-xl font-bold text-accent">أمثلة من القرآن الكريم</h2>
        {loading && <p className="text-sm text-faint">جاري تحميل الأمثلة…</p>}
        {!loading && examples.length === 0 && <p className="text-sm text-faint">تعذّر تحميل أمثلة حيّة حاليًا.</p>}
        <ul className="space-y-4">
          {examples.map((ayah) => (
            <li key={ayah.number} className="ayah-frame p-5">
              <TajweedText segments={ayah.segments} className="font-quran text-2xl" />
              <div className="hair-gold my-3 max-w-40" />
              <p className="text-xs font-medium text-faint">
                سورة {ayah.surah} — الآية {ayah.numberInSurah}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="card-lux relative overflow-hidden p-7" style={{ borderColor: 'color-mix(in srgb, var(--c-gold) 50%, var(--c-line))' }}>
        <span
          aria-hidden
          className="absolute -left-10 -top-10 flex h-32 w-32 items-center justify-center rounded-full text-[90px] leading-none opacity-10"
          style={{ color: 'var(--c-gold)', fontFamily: 'var(--font-display)' }}
        >
          ؟
        </span>
        <h2 className="font-display text-xl font-bold text-ink">اختبر نفسك</h2>
        <p className="mb-5 mt-2 text-sm leading-relaxed text-muted">
          ما اسم الحكم الذي يوضحه اللون <span style={{ color: rule.color }} className="font-bold">●</span> في الأمثلة
          أعلاه؟
        </p>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {choices.map((c) => {
            const isCorrect = c.id === rule.id
            const isSelected = selected === c.id
            return (
              <button
                key={c.id}
                onClick={() => {
                  setSelected(c.id)
                  if (isCorrect) markComplete(rule.id)
                }}
                className={`rounded-xl border px-4 py-2.5 text-right text-sm font-bold transition-all duration-200 ${
                  isSelected
                    ? isCorrect
                      ? 'border-accent bg-accent-soft text-accent shadow-sm'
                      : 'border-danger bg-danger-soft text-danger'
                    : 'border-line bg-elevated/60 text-ink hover:-translate-y-0.5 hover:border-gold/60 hover:shadow-sm'
                }`}
              >
                {c.nameAr}
              </button>
            )
          })}
        </div>
        {selected && (
          <p className={`mt-4 text-sm font-black ${selected === rule.id ? 'text-accent' : 'text-danger'}`}>
            {selected === rule.id ? '✓ إجابة صحيحة! تم تسجيل هذا الدرس كمكتمل.' : 'إجابة غير صحيحة، حاول مجددًا.'}
          </p>
        )}
        {isComplete && !selected && <p className="mt-4 text-sm font-black text-accent">✓ أكملت هذا الدرس سابقًا.</p>}
      </section>
    </div>
  )
}
