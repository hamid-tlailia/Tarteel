import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'

const NAV_ITEMS = [
  { to: '/', label: 'الرئيسية', end: true },
  { to: '/lessons', label: 'أحكام التجويد' },
  { to: '/quran', label: 'المصحف' },
  { to: '/practice', label: 'التلاوة والتصحيح' },
  { to: '/progress', label: 'تقدّمي' },
]

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-brand-200/60 bg-[#f4f1ea]/90 backdrop-blur dark:border-brand-900/60 dark:bg-[#0b1512]/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2 text-xl font-black text-brand-700 dark:text-brand-300">
            <span aria-hidden>﴾</span>
            ورتل
          </NavLink>
          <nav className="flex flex-wrap items-center gap-1 text-sm">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  clsx(
                    'rounded-full px-3 py-1.5 font-medium transition-colors',
                    isActive
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'text-emerald-900/70 hover:bg-brand-100 dark:text-brand-100/70 dark:hover:bg-brand-900/40',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-brand-200/60 py-4 text-center text-xs text-emerald-900/50 dark:border-brand-900/60 dark:text-brand-100/40">
        النصوص القرآنية وأحكام التجويد مصدرها alquran.cloud — يعمل التعرّف الصوتي بالكامل داخل متصفحك.
      </footer>
    </div>
  )
}
