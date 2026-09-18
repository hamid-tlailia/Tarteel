import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useProgressStore } from '../store/progressStore'
import { TAJWEED_RULES } from '../lib/tajweed'
import { Link } from 'react-router-dom'

export function ProgressPage() {
  const attempts = useProgressStore((s) => s.attempts)
  const completedLessons = useProgressStore((s) => s.completedLessons)
  const streak = useProgressStore((s) => s.streakDays())

  const chartData = attempts.slice(-30).map((a, i) => ({
    name: `#${i + 1}`,
    دقة: a.accuracy,
    date: new Date(a.date).toLocaleDateString('ar-EG'),
  }))

  const avgAccuracy = attempts.length
    ? Math.round(attempts.reduce((sum, a) => sum + a.accuracy, 0) / attempts.length)
    : 0

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-black text-emerald-900 dark:text-brand-50">تقدّمي</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="محاولات التلاوة" value={attempts.length} />
        <StatCard label="متوسط الدقة" value={`${avgAccuracy}%`} />
        <StatCard label="أيام متتالية" value={streak} />
      </div>

      <section className="rounded-2xl border border-brand-200/70 bg-white/70 p-5 dark:border-brand-900/50 dark:bg-white/5">
        <h2 className="mb-4 text-lg font-bold text-brand-700 dark:text-brand-300">تطور دقة التلاوة</h2>
        {attempts.length === 0 ? (
          <p className="text-sm text-emerald-900/60 dark:text-brand-100/60">
            لا توجد محاولات بعد.{' '}
            <Link to="/practice" className="text-brand-700 underline dark:text-brand-300">
              ابدأ أول تلاوة
            </Link>
            .
          </p>
        ) : (
          <div className="h-64" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#d1fae5" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                <Tooltip
                  formatter={(value) => [`${value}%`, 'الدقة']}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''}
                />
                <Line type="monotone" dataKey="دقة" stroke="#059669" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-brand-200/70 bg-white/70 p-5 dark:border-brand-900/50 dark:bg-white/5">
        <h2 className="mb-4 text-lg font-bold text-brand-700 dark:text-brand-300">
          الدروس المكتملة ({completedLessons.length}/{TAJWEED_RULES.length})
        </h2>
        <div className="flex flex-wrap gap-2">
          {TAJWEED_RULES.map((rule) => {
            const done = completedLessons.includes(rule.id)
            return (
              <Link
                key={rule.id}
                to={`/lessons/${rule.id}`}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  done
                    ? 'border-brand-500 bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-100'
                    : 'border-brand-200 text-emerald-900/50 hover:bg-brand-50 dark:border-brand-800 dark:text-brand-100/50'
                }`}
              >
                {done && '✓ '}
                {rule.nameAr}
              </Link>
            )
          })}
        </div>
      </section>

      {attempts.length > 0 && (
        <section className="rounded-2xl border border-brand-200/70 bg-white/70 p-5 dark:border-brand-900/50 dark:bg-white/5">
          <h2 className="mb-4 text-lg font-bold text-brand-700 dark:text-brand-300">آخر المحاولات</h2>
          <ul className="divide-y divide-brand-100 dark:divide-brand-900/40">
            {[...attempts]
              .slice(-10)
              .reverse()
              .map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                  <span>
                    {a.surahName} ({a.ayahFrom}-{a.ayahTo})
                  </span>
                  <span className="font-bold text-brand-700 dark:text-brand-300">{a.accuracy}%</span>
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
    <div className="rounded-2xl border border-brand-200/70 bg-white/70 p-5 text-center dark:border-brand-900/50 dark:bg-white/5">
      <div className="text-3xl font-black text-brand-700 dark:text-brand-300">{value}</div>
      <div className="mt-1 text-sm text-emerald-900/60 dark:text-brand-100/60">{label}</div>
    </div>
  )
}
