import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'

/**
 * A dropdown that looks like the rest of the app.
 *
 * Native <select> draws its list with the operating system's own widget: on Android that is
 * a plain grey sheet in the system font, ignoring the theme, the Arabic face and the
 * rounded, gilded surfaces everything else here uses. It also cannot show more than a line
 * of text per option, which a pace needs.
 *
 * The list is portalled to <body> for the same reason the tajweed tooltip is: `.card-lux`
 * carries a backdrop-filter, and that makes it the containing block for `position: fixed`
 * descendants, so a panel positioned from viewport coordinates inside one lands somewhere
 * else entirely.
 */

export interface DropdownOption<T extends string | number> {
  value: T
  label: string
  /** A second line under the label, for options that need explaining. */
  hint?: string
  /** Shown at the leading edge — a dot, a number, an icon. */
  badge?: ReactNode
}

interface DropdownProps<T extends string | number> {
  value: T
  options: DropdownOption<T>[]
  onChange: (value: T) => void
  label?: string
  disabled?: boolean
  className?: string
  /** Renders the trigger's text when the plain label is not what should be shown there. */
  renderValue?: (option: DropdownOption<T> | undefined) => ReactNode
}

const HIDDEN: CSSProperties = { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' }

export function Dropdown<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
  renderValue,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>(HIDDEN)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const listId = useId()
  const selected = options.find((o) => o.value === value)

  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const list = listRef.current
    if (!trigger || !list) return
    const margin = 8
    const t = trigger.getBoundingClientRect()
    const l = list.getBoundingClientRect()
    // Below the trigger by default, above it when there is no room — and never wider than
    // the screen, which matters on a phone where the trigger can be nearly full width.
    const top = t.bottom + margin + l.height <= window.innerHeight - margin ? t.bottom + margin : Math.max(margin, t.top - l.height - margin)
    const left = Math.min(Math.max(t.left, margin), Math.max(margin, window.innerWidth - l.width - margin))
    setStyle({ position: 'fixed', top, left, width: t.width, visibility: 'visible', zIndex: 60 })
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onDocPointer = (e: Event) => {
      const target = e.target as Node
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      close()
    }
    // Capture phase, but not for scrolls that happen *inside* the list. The point of
    // closing on scroll is that the panel is positioned from a measured rect and would be
    // left behind if the page moved under it — the list's own scrolling moves nothing.
    // Listening in capture without that check made a long list impossible to scroll at all:
    // the first touch-drag closed it. The surah list is 114 items long.
    const onScroll = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return
      close()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDocPointer)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDocPointer)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'flex w-full items-center justify-between gap-2 rounded-xl border border-line bg-elevated px-3 py-2.5 text-right text-sm font-medium text-ink shadow-sm transition',
          'hover:border-gold/60 focus:border-gold focus:outline-none disabled:opacity-50',
          open && 'border-gold',
          className,
        )}
      >
        <ChevronDown className={clsx('h-4 w-4 shrink-0 text-faint transition-transform', open && 'rotate-180')} />
        <span className="min-w-0 flex-1 truncate">
          {renderValue ? renderValue(selected) : (selected?.label ?? '—')}
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            dir="rtl"
            style={{ ...style, WebkitOverflowScrolling: 'touch' }}
            className="card-lux max-h-[min(22rem,60vh)] overflow-y-auto overscroll-contain rounded-2xl! p-1.5 shadow-[var(--shadow-lift)]"
          >
            {options.map((option) => {
              const active = option.value === value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-right transition',
                    active ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-bg-deep',
                  )}
                >
                  {option.badge !== undefined && <span className="shrink-0">{option.badge}</span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">{option.label}</span>
                    {option.hint && <span className="mt-0.5 block text-xs leading-snug text-muted">{option.hint}</span>}
                  </span>
                  {active && <CheckIcon className="h-4 w-4 shrink-0 text-accent" />}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m20 6-11 11-5-5" />
    </svg>
  )
}
