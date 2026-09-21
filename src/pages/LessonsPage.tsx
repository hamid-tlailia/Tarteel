import { Link } from 'react-router-dom'
import { TAJWEED_CATEGORIES, TAJWEED_RULES } from '../lib/tajweed'
import { useProgressStore } from '../store/progressStore'

export function LessonsPage() {
  const isComplete = useProgressStore((s) => s.isLessonComplete)
  const completedCount = useProgressStore((s) => s.completedLessons.length)
  const progress = Math.round((completedCount / TAJWEED_RULES.length) * 100)

  return (
    <div className="space-y-10">
      <div className="card-lux pattern-panel relative overflow-hidden p-6 sm:p-8">
        <div className="relative">
          <h1 className="text-gilded font-display text-3xl font-bold">أحكام التجويد</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            أكملت {completedCount} من {TAJWEED_RULES.length} حكمًا. اضغط على أي حكم لدراسته مع أمثلة قرآنية حيّة واختبار
            قصير.
          </p>
          <div className="mt-5 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-line-soft">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${progress}%`,
                  background: 'linear-gradient(90deg, var(--c-gold-deep), var(--c-gold), var(--c-gold-soft))',
                }}
              />
            </div>
            <span className="text-sm font-black text-gold">{progress}%</span>
          </div>
        </div>
      </div>

      {TAJWEED_CATEGORIES.map((cat) => {
        const rules = TAJWEED_RULES.filter((r) => r.category === cat.id)
        if (rules.length === 0) return null
        return (
          <section key={cat.id}>
            <h2 className="title-ornament mb-4 font-display text-xl font-bold text-accent">{cat.nameAr}</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rules.map((rule) => (
                <Link key={rule.id} to={`/lessons/${rule.id}`} className="card-lux card-hover group relative flex flex-col p-5">
                  <div className="mb-2.5 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2.5 font-display text-lg font-bold text-ink transition-colors group-hover:text-accent">
                      <span
                        aria-hidden
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ring-black/10"
                        style={{ backgroundColor: rule.color, boxShadow: `0 0 12px color-mix(in srgb, ${rule.color} 45%, transparent)` }}
                      />
                      {rule.nameAr}
                    </span>
                    {isComplete(rule.id) && (
                      <span
                        aria-label="مكتمل"
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-black text-accent"
                      >
                        ✓
                      </span>
                    )}
                  </div>
                  <p className="line-clamp-2 flex-1 text-xs leading-relaxed text-muted">{rule.description}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {rule.durationAr && (
                      <span className="rounded-full border border-gold/40 px-2.5 py-0.5 text-[10px] font-bold text-gold">
                        {rule.durationAr}
                      </span>
                    )}
                    {rule.letters && (
                      <span className="font-quran text-xs text-faint" style={{ color: rule.color }}>
                        {rule.letters}
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
