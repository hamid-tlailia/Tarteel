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
      <div>
        <p>لم يتم العثور على هذا الحكم.</p>
        <Link to="/lessons" className="text-brand-700 underline">
          العودة إلى الدروس
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <Link to="/lessons" className="text-sm text-brand-700 hover:underline dark:text-brand-300">
        ← جميع الأحكام
      </Link>

      <header className="rounded-2xl border border-brand-200/70 bg-white/70 p-6 dark:border-brand-900/50 dark:bg-white/5">
        <div className="flex items-center gap-3">
          <span className="tajweed-legend-dot h-4 w-4" style={{ backgroundColor: rule.color }} />
          <h1 className="text-2xl font-black text-emerald-900 dark:text-brand-50">{rule.nameAr}</h1>
          <span className="text-sm text-emerald-900/50 dark:text-brand-100/50">{rule.nameEn}</span>
        </div>
        {rule.letters && (
          <p className="mt-3 font-quran text-2xl" style={{ color: rule.color }}>
            {rule.letters}
          </p>
        )}
        <p className="mt-3 leading-loose text-emerald-900/80 dark:text-brand-100/80">{rule.description}</p>
      </header>

      <section>
        <h2 className="mb-3 text-lg font-bold text-brand-700 dark:text-brand-300">أمثلة من القرآن الكريم</h2>
        {loading && <p className="text-sm text-emerald-900/60 dark:text-brand-100/60">جاري تحميل الأمثلة…</p>}
        {!loading && examples.length === 0 && (
          <p className="text-sm text-emerald-900/60 dark:text-brand-100/60">تعذّر تحميل أمثلة حيّة حاليًا.</p>
        )}
        <ul className="space-y-3">
          {examples.map((ayah) => (
            <li
              key={ayah.number}
              className="rounded-xl border border-brand-200/60 bg-white/60 p-4 dark:border-brand-900/40 dark:bg-white/5"
            >
              <TajweedText segments={ayah.segments} className="font-quran text-2xl" />
              <p className="mt-2 text-xs text-emerald-900/50 dark:text-brand-100/50">
                سورة {ayah.surah} — الآية {ayah.numberInSurah}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-gold-400/50 bg-gold-400/10 p-6">
        <h2 className="mb-3 text-lg font-bold text-emerald-900 dark:text-brand-50">اختبر نفسك</h2>
        <p className="mb-4 text-sm text-emerald-900/80 dark:text-brand-100/80">
          ما اسم الحكم الذي يوضحه اللون <span style={{ color: rule.color }} className="font-bold">●</span> في الأمثلة أعلاه؟
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
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
                className={`rounded-lg border px-4 py-2 text-right text-sm font-medium transition ${
                  isSelected
                    ? isCorrect
                      ? 'border-brand-600 bg-brand-100 text-brand-800'
                      : 'border-red-400 bg-red-50 text-red-700'
                    : 'border-brand-200 bg-white hover:bg-brand-50 dark:border-brand-900 dark:bg-white/5 dark:hover:bg-white/10'
                }`}
              >
                {c.nameAr}
              </button>
            )
          })}
        </div>
        {selected && (
          <p className={`mt-3 text-sm font-bold ${selected === rule.id ? 'text-brand-700' : 'text-red-600'}`}>
            {selected === rule.id ? '✓ إجابة صحيحة! تم تسجيل هذا الدرس كمكتمل.' : 'إجابة غير صحيحة، حاول مجددًا.'}
          </p>
        )}
        {isComplete && !selected && <p className="mt-3 text-sm font-bold text-brand-700">✓ أكملت هذا الدرس سابقًا.</p>}
      </section>
    </div>
  )
}
