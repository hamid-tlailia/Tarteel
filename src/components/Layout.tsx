import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import { HomeIcon, LessonsIcon, ProgressIcon, PracticeIcon, QuranIcon } from './NavIcons'
import { ThemeSwitcher } from './ThemeSwitcher'

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
      <header className="sticky top-0 z-30 border-b border-line/70" style={{ backgroundColor: 'var(--glass)', backdropFilter: 'blur(14px)' }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <NavLink to="/" className="group flex items-center gap-2.5">
            <span
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-gold/50 bg-surface font-brand text-lg text-gold shadow-sm transition group-hover:border-gold"
            >
              ٱ
            </span>
            <span className="leading-none">
              <span className="text-gilded block font-brand text-2xl font-bold tracking-wide">ورتل</span>
              <span className="mt-1 block text-[10px] font-medium tracking-[0.3em] text-faint">
                TAJWEED · ذكاء اصطناعي
              </span>
            </span>
          </NavLink>
          <ThemeSwitcher />
        </div>
        <div className="hair-gold" />
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-7 pb-28">
        <Outlet />
      </main>

      <footer className="hidden px-4 pb-28 pt-2 text-center sm:block sm:pb-6">
        <div className="hair-gold mx-auto mb-4 max-w-md" />
        <p className="text-xs leading-relaxed text-faint">
          <span className="font-brand text-sm text-gold">﴾</span>{' '}
          النصوص القرآنية وأحكام التجويد مصدرها alquran.cloud — يعمل التعرّف الصوتي بالكامل داخل متصفحك دون رفع صوتك لأي
          خادم. <span className="font-brand text-sm text-gold">﴿</span>
        </p>
      </footer>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 px-3 pb-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
        aria-label="التنقل الرئيسي"
      >
        <div
          className="mx-auto flex max-w-lg items-stretch justify-between gap-1 rounded-3xl border border-line/80 p-1.5 shadow-[var(--shadow-lift)]"
          style={{ backgroundColor: 'var(--glass)', backdropFilter: 'blur(16px)' }}
        >
          {NAV_ITEMS.map(({ to, label, end, Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx(
                  'flex flex-1 flex-col items-center gap-0.5 rounded-2xl px-1 py-1.5 text-[11px] font-semibold transition-all duration-200',
                  isActive ? 'bg-accent-soft text-accent' : 'text-faint hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative flex h-8 w-12 items-center justify-center">
                    <Icon className={clsx('h-6 w-6 transition-transform', isActive && 'scale-110')} />
                    {isActive && (
                      <span
                        aria-hidden
                        className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-gold shadow-[0_0_6px_var(--c-gold)]"
                      />
                    )}
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
