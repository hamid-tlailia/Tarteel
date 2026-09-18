import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import { HomeIcon, LessonsIcon, ProgressIcon, PracticeIcon, QuranIcon } from './NavIcons'

const NAV_ITEMS = [
  { to: '/', label: 'الرئيسية', end: true, Icon: HomeIcon },
  { to: '/lessons', label: 'الأحكام', Icon: LessonsIcon },
  { to: '/quran', label: 'المصحف', Icon: QuranIcon },
  { to: '/practice', label: 'التلاوة', Icon: PracticeIcon },
  { to: '/progress', label: 'تقدّمي', Icon: ProgressIcon },
]

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-brand-200/60 bg-[#f4f1ea]/90 backdrop-blur dark:border-brand-900/60 dark:bg-[#0b1512]/90">
        <div className="mx-auto flex max-w-6xl items-center px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2 text-xl font-black text-brand-700 dark:text-brand-300">
            <span aria-hidden>﴾</span>
            ورتل
          </NavLink>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-24">
        <Outlet />
      </main>

      <footer className="hidden border-t border-brand-200/60 py-4 text-center text-xs text-emerald-900/50 sm:block dark:border-brand-900/60 dark:text-brand-100/40">
        النصوص القرآنية وأحكام التجويد مصدرها alquran.cloud — يعمل التعرّف الصوتي بالكامل داخل متصفحك.
      </footer>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-brand-200/70 bg-[#f4f1ea]/95 backdrop-blur dark:border-brand-900/70 dark:bg-[#0b1512]/95"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="التنقل الرئيسي"
      >
        <div className="mx-auto flex max-w-6xl items-stretch justify-between px-2">
          {NAV_ITEMS.map(({ to, label, end, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx(
                  'flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors',
                  isActive
                    ? 'text-brand-700 dark:text-brand-300'
                    : 'text-emerald-900/50 hover:text-brand-600 dark:text-brand-100/45 dark:hover:text-brand-300',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={clsx(
                      'flex h-8 w-12 items-center justify-center rounded-2xl transition-colors',
                      isActive && 'bg-brand-100 dark:bg-brand-900/50',
                    )}
                  >
                    <Icon className="h-6 w-6" />
                  </span>
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}
