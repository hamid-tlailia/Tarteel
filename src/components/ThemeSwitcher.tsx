import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { THEMES, useThemeStore } from '../store/themeStore'

function PaletteIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 3a9 9 0 1 0 0 18c.9 0 1.5-.7 1.5-1.5 0-.9-.7-1.5-.7-2.3 0-.7.6-1.2 1.3-1.2H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8Z" />
      <circle cx="7.8" cy="11.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="7.8" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ThemeSwitcher() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const active = THEMES.find((t) => t.id === theme)!

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`تغيير السمة (الحالية: ${active.nameAr})`}
        className="flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1.5 text-sm font-medium text-muted transition hover:border-gold/60 hover:text-ink"
      >
        <PaletteIcon className="h-4.5 w-4.5 text-gold" />
        <span className="hidden items-center gap-1 sm:flex" aria-hidden>
          {active.swatch.map((c) => (
            <span key={c} className="h-3 w-3 rounded-full ring-1 ring-line" style={{ backgroundColor: c }} />
          ))}
        </span>
        <span className="hidden text-xs font-bold md:inline">{active.nameAr}</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="سمات التطبيق"
          className="card-lux absolute left-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-2xl! p-1.5"
        >
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="option"
              aria-selected={t.id === theme}
              onClick={() => {
                setTheme(t.id)
                setOpen(false)
              }}
              className={clsx(
                'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-right transition',
                t.id === theme ? 'bg-accent-soft' : 'hover:bg-line-soft',
              )}
            >
              <span className="flex h-7 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line" aria-hidden>
                <span className="h-full w-1/2" style={{ backgroundColor: t.swatch[0] }} />
                <span className="h-full w-1/2" style={{ backgroundColor: t.swatch[1] }} />
              </span>
              <span className="flex-1 leading-tight">
                <span className={clsx('block text-sm font-bold', t.id === theme ? 'text-accent' : 'text-ink')}>{t.nameAr}</span>
                <span className="block text-[11px] text-faint">{t.nameEn}</span>
              </span>
              {t.id === theme && <span className="text-gold">✦</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
