import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useProgressStore } from '../store/progressStore'
import { useThemeStore } from '../store/themeStore'
import { TAJWEED_RULES, TAJWEED_RULE_MAP } from '../lib/tajweed'
import type { TajweedRuleId } from '../types/quran'
import { Link } from 'react-router-dom'
import clsx from 'clsx'

/** Resolves a themed CSS variable to a concrete color so recharts (SVG attributes) can use it;
 * re-runs whenever the active theme changes. */
function useThemeColor(varName: string, fallback: string) {
  const theme = useThemeStore((s) => s.theme)
  return useMemo(() => {
    if (typeof window === 'undefined') return fallback
    const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
    return value || fallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, varName, fallback])
}

export function ProgressPage() {
  const attempts = useProgressStore((s) => s.attempts)
  const completedLessons = useProgressStore((s) => s.completedLessons)
  const streak = useProgressStore((s) => s.streakDays())

  const lineColor = useThemeColor('--c-gold', '#ab8734')
  const gridColor = useThemeColor('--c-line', '#e3d9c2')
  const tickColor = useThemeColor('--c-faint', '#8b9688')
  const surfaceColor = useThemeColor('--c-elevated', '#ffffff')

  const chartData = attempts.slice(-30).map((a, i) => ({
    name: `#${i + 1}`,
    'دقة الكلمات': a.accuracy,
    date: new Date(a.date).toLocaleDateString('ar-EG'),
  }))

  const avgAccuracy = attempts.length
    ? Math.round(attempts.reduce((sum, a) => sum + a.accuracy, 0) / attempts.length)
    : 0

  /**
   * Tajweed progress, kept apart from the words on purpose.
   *
   * These are two different claims resting on two different kinds of evidence: that a word was
   * said as written, and that a ruling inside it was performed. Averaging them into one line
   * would produce a number that means neither. So the rulings are counted — verified, faulted,
   * beyond what the app could check — and the ones that came back faulted are listed by name,
   * because "go back to the ikhfāʾ" is advice a learner can act on and a percentage is not.
   */
  const rulings = useMemo(() => {
    const met = new Map<TajweedRuleId, number>()
    const faulted = new Map<TajweedRuleId, number>()
    let totals = { met: 0, faulted: 0, undecided: 0 }
    let measured = 0
    for (const attempt of attempts) {
      if (!attempt.rulings) continue
      measured++
      totals = {
        met: totals.met + attempt.rulings.met,
        faulted: totals.faulted + attempt.rulings.faulted,
        undecided: totals.undecided + attempt.rulings.undecided,
      }
      for (const rule of attempt.metRules ?? []) met.set(rule, (met.get(rule) ?? 0) + 1)
      for (const rule of attempt.faultedRules ?? []) faulted.set(rule, (faulted.get(rule) ?? 0) + 1)
    }
    const needsReview = [...faulted.entries()].sort((a, b) => b[1] - a[1])
    const verified = [...met.entries()].filter(([rule]) => !faulted.has(rule)).sort((a, b) => b[1] - a[1])
    const seen = new Set([...met.keys(), ...faulted.keys()])
    const untouched = TAJWEED_RULES.filter((r) => !seen.has(r.id))
    return { totals, measured, needsReview, verified, untouched }
  }, [attempts])

  return (
    <div className="space-y-9">
      <div>
        <h1 className="text-gilded font-display text-3xl font-bold">تقدّمي</h1>
        <div className="hair-gold mt-4 max-w-sm" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="محاولات التلاوة" value={attempts.length} />
        <StatCard label="متوسط دقة الكلمات" value={`${avgAccuracy}%`} />
        <StatCard label="أيام متتالية" value={streak} />
      </div>

      {/* What was practised, and what to go back to — rulings, not a percentage. */}
      <section className="card-lux space-y-4 p-6">
        <div>
          <h2 className="title-ornament font-display text-xl font-bold text-accent">أحكام التجويد في تلاواتك</h2>
          <p className="mt-2 text-xs leading-relaxed text-faint">
            هذه أعداد أحكام، لا نسبة. لا تُجمع مع دقّة الكلمات لأنّهما دعويان مختلفتان: أن الكلمة قُرئت كما في
            المصحف شيء، وأنّ حكمها أُدّي شيء آخر.
          </p>
        </div>

        {rulings.measured === 0 ? (
          <p className="rounded-xl border border-line-soft bg-bg/40 px-4 py-3 text-sm text-faint">
            لم تُسجَّل بعد تلاوة يحمل تحليلها أحكامًا. سجّل تلاوة في صفحة «التلاوة» وسيظهر هنا ما تحقّقنا منه وما
            يحتاج مراجعة.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-ok/40 bg-ok/10 px-2 py-2.5">
                <div className="font-display text-xl font-bold text-ok">{rulings.totals.met}</div>
                <div className="mt-0.5 text-[11px] font-bold leading-tight text-ok">تحقّقنا من أدائه</div>
              </div>
              <div className="rounded-lg border border-warn/40 bg-warn-soft px-2 py-2.5">
                <div className="font-display text-xl font-bold text-warn">{rulings.totals.faulted}</div>
                <div className="mt-0.5 text-[11px] font-bold leading-tight text-warn">ظهر فيه خلل</div>
              </div>
              <div className="rounded-lg border border-line-soft bg-line-soft/40 px-2 py-2.5">
                <div className="font-display text-xl font-bold text-muted">{rulings.totals.undecided}</div>
                <div className="mt-0.5 text-[11px] font-bold leading-tight text-muted">غير محسوم</div>
              </div>
            </div>

            {rulings.needsReview.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-bold text-warn">يحتاج مراجعة</h3>
                <div className="flex flex-wrap gap-2">
                  {rulings.needsReview.map(([rule, count]) => (
                    <Link
                      key={rule}
                      to={`/lessons/${rule}`}
                      className="rounded-xl border border-warn/40 bg-warn-soft px-3 py-1.5 text-xs font-bold text-warn transition hover:border-warn"
                    >
                      {TAJWEED_RULE_MAP[rule]?.nameAr ?? rule} · {count}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {rulings.verified.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-bold text-ok">تحقّقنا من أدائك فيه</h3>
                <div className="flex flex-wrap gap-2">
                  {rulings.verified.map(([rule, count]) => (
                    <span key={rule} className="rounded-xl border border-ok/40 bg-ok/10 px-3 py-1.5 text-xs font-bold text-ok">
                      {TAJWEED_RULE_MAP[rule]?.nameAr ?? rule} · {count}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {rulings.untouched.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-bold text-muted">لم تمرّ بها بعد</h3>
                <p className="text-xs leading-relaxed text-faint">
                  {rulings.untouched.length} حكمًا لم يظهر في ما تلوتَه حتى الآن — ليست خطأً ولا نجاحًا، وإنما لم
                  تُختبر. اختر مقطعًا يحتويها من صفحة التلاوة.
                </p>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card-lux p-6">
        <h2 className="title-ornament mb-5 font-display text-xl font-bold text-accent">تطوّر دقة الكلمات</h2>
        {/* Named for what it measures. This series comes from word matching alone — whether the
            words were said as written — and nothing in it is a judgement on tajweed, which is
            counted ruling by ruling on the practice page and deliberately never averaged. */}
        <p className="mb-4 text-xs leading-relaxed text-faint">
          هذا الرقم يقيس مطابقة الكلمات للنص فقط. أحكام التجويد لا تُختصر في نسبة، وتُعرض حكمًا حكمًا بعد كل تلاوة.
        </p>
        {attempts.length === 0 ? (
          <p className="text-sm text-muted">
            لا توجد محاولات بعد.{' '}
            <Link to="/practice" className="font-bold text-accent underline decoration-gold underline-offset-4 hover:text-gold">
              ابدأ أول تلاوة
            </Link>
            .
          </p>
        ) : (
          <div className="h-64" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: tickColor }} stroke={gridColor} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: tickColor }} stroke={gridColor} />
                <Tooltip
                  formatter={(value) => [`${value}%`, 'دقة الكلمات']}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''}
                  contentStyle={{
                    backgroundColor: surfaceColor,
                    border: `1px solid ${gridColor}`,
                    borderRadius: '0.75rem',
                    color: tickColor,
                    fontFamily: 'Tajawal, sans-serif',
                    fontSize: '0.8rem',
                  }}
                />
                <Line type="monotone" dataKey="دقة الكلمات" stroke={lineColor} strokeWidth={2.5} dot={{ r: 3, fill: lineColor, strokeWidth: 0 }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="card-lux p-6">
        <h2 className="title-ornament mb-5 font-display text-xl font-bold text-accent">
          الدروس المكتملة ({completedLessons.length}/{TAJWEED_RULES.length})
        </h2>
        <div className="flex flex-wrap gap-2">
          {TAJWEED_RULES.map((rule) => {
            const done = completedLessons.includes(rule.id)
            return (
              <Link
                key={rule.id}
                to={`/lessons/${rule.id}`}
                className={clsx(
                  'flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-bold transition hover:-translate-y-0.5',
                  done
                    ? 'border-gold/60 bg-accent-soft text-accent shadow-sm'
                    : 'border-line bg-elevated/50 text-faint hover:border-gold/40 hover:text-muted',
                )}
              >
                {done && <span className="text-gold">✦</span>}
                {rule.nameAr}
              </Link>
            )
          })}
        </div>
      </section>

      {attempts.length > 0 && (
        <section className="card-lux p-6">
          <h2 className="title-ornament mb-5 font-display text-xl font-bold text-accent">آخر المحاولات</h2>
          <ul className="divide-y divide-line">
            {[...attempts]
              .slice(-10)
              .reverse()
              .map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <span className="font-medium text-muted">
                    <span className="font-display font-bold text-ink">{a.surahName}</span> ({a.ayahFrom}-{a.ayahTo})
                  </span>
                  <span
                    className={clsx(
                      'rounded-full px-3 py-1 text-xs font-black',
                      a.accuracy >= 80 ? 'bg-accent-soft text-accent' : a.accuracy >= 50 ? 'bg-warn-soft text-warn' : 'bg-danger-soft text-danger',
                    )}
                  >
                    {a.accuracy}%
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card-lux card-hover relative overflow-hidden p-6 text-center">
      <span aria-hidden className="absolute inset-x-8 top-0 h-px bg-gradient-to-l from-transparent via-gold/70 to-transparent" />
      <div className="text-gilded font-display text-4xl font-bold">{value}</div>
      <div className="mt-1.5 text-sm font-semibold text-muted">{label}</div>
    </div>
  )
}
