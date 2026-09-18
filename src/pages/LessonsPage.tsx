import { Link } from 'react-router-dom'
import { TAJWEED_CATEGORIES, TAJWEED_RULES } from '../lib/tajweed'
import { useProgressStore } from '../store/progressStore'

export function LessonsPage() {
  const isComplete = useProgressStore((s) => s.isLessonComplete)
  const completedCount = useProgressStore((s) => s.completedLessons.length)

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-black text-emerald-900 dark:text-brand-50">أحكام التجويد</h1>
        <p className="mt-1 text-emerald-900/70 dark:text-brand-100/70">
          أكملت {completedCount} من {TAJWEED_RULES.length} حكمًا. اضغط على أي حكم لدراسته مع أمثلة قرآنية حيّة واختبار قصير.
        </p>
      </div>

      {TAJWEED_CATEGORIES.map((cat) => {
        const rules = TAJWEED_RULES.filter((r) => r.category === cat.id)
        if (rules.length === 0) return null
        return (
          <section key={cat.id}>
            <h2 className="mb-3 text-lg font-bold text-brand-700 dark:text-brand-300">{cat.nameAr}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rules.map((rule) => (
                <Link
                  key={rule.id}
                  to={`/lessons/${rule.id}`}
                  className="rounded-xl border border-brand-200/70 bg-white/70 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-brand-900/50 dark:bg-white/5"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-2 font-bold text-emerald-900 dark:text-brand-50">
                      <span className="tajweed-legend-dot" style={{ backgroundColor: rule.color }} />
                      {rule.nameAr}
                    </span>
                    {isComplete(rule.id) && <span className="text-brand-600 dark:text-brand-300">✓</span>}
                  </div>
                  <p className="line-clamp-2 text-xs text-emerald-900/60 dark:text-brand-100/60">{rule.description}</p>
                </Link>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
