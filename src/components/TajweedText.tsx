import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { TajweedSegment } from '../types/quran'
import { TAJWEED_RULE_MAP } from '../lib/tajweed'

interface TajweedTextProps {
  segments: TajweedSegment[]
  colored?: boolean
  className?: string
  interactive?: boolean
}

const HIDDEN_STYLE: CSSProperties = { position: 'fixed', top: -9999, left: -9999 }

export function TajweedText({ segments, colored = true, className, interactive = true }: TajweedTextProps) {
  const [active, setActive] = useState<number | null>(null)
  const triggerRefs = useRef<Record<number, HTMLSpanElement | null>>({})
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>(HIDDEN_STYLE)

  // Position the tooltip from measured rects so it never runs off-screen near
  // the start/end of a line — a fixed "centered above" offset used to overflow
  // the viewport for tajweed letters near either edge of the text.
  //
  // The rects are viewport coordinates, which is why the tooltip has to be portalled to
  // <body> below: `position: fixed` resolves against the nearest ancestor with a filter,
  // backdrop-filter or transform rather than against the viewport, and .card-lux — the
  // panel this text sits in — carries a backdrop-filter. Left inside it, the tooltip was
  // offset by the card's own position, landing outside it, clipped by its rounded box and
  // painted beneath the next card. It was being rendered the whole time; it just was not
  // where anyone could see it.
  useLayoutEffect(() => {
    if (active === null) return
    const trigger = triggerRefs.current[active]
    const tooltip = tooltipRef.current
    if (!trigger || !tooltip) return

    const margin = 8
    const triggerRect = trigger.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()

    let left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2
    left = Math.min(Math.max(left, margin), window.innerWidth - tooltipRect.width - margin)

    let top = triggerRect.top - tooltipRect.height - margin
    if (top < margin) top = triggerRect.bottom + margin

    setTooltipStyle({ position: 'fixed', left, top, visibility: 'visible' })
  }, [active])

  // Close on scroll/resize/Escape/outside click so a stale popover never lingers off-position.
  useEffect(() => {
    if (active === null) return
    const close = () => setActive(null)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (tooltipRef.current?.contains(target)) return
      const onATrigger = Object.values(triggerRefs.current).some((el) => el?.contains(target))
      if (onATrigger) return
      close()
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('click', onDocClick)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('click', onDocClick)
    }
  }, [active])

  return (
    <span className={className} dir="rtl">
      {segments.map((seg, i) => {
        const rule = colored ? seg.rule && TAJWEED_RULE_MAP[seg.rule] : undefined
        if (!rule) return <span key={i}>{seg.text}</span>
        return (
          <span key={i} className="relative">
            <span
              ref={(el) => {
                triggerRefs.current[i] = el
              }}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              style={{ color: rule.color }}
              className={
                interactive
                  ? 'cursor-pointer rounded-sm underline decoration-dotted decoration-2 underline-offset-4 transition-[text-shadow] duration-200 hover:[text-shadow:0_0_14px_currentColor]'
                  : undefined
              }
              onClick={
                interactive
                  ? (e) => {
                      e.stopPropagation()
                      setActive(active === i ? null : i)
                    }
                  : undefined
              }
              onKeyDown={
                interactive
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setActive(active === i ? null : i)
                      }
                    }
                  : undefined
              }
            >
              {seg.text}
            </span>
            {interactive &&
              active === i &&
              createPortal(
              <div
                ref={tooltipRef}
                style={{ ...tooltipStyle, zIndex: 60 }}
                className="card-lux w-60 rounded-2xl! p-3.5 text-right font-sans text-sm leading-relaxed text-ink shadow-[var(--shadow-lift)]"
                dir="rtl"
              >
                <span className="mb-1.5 flex items-center gap-2 font-display text-base font-bold" style={{ color: rule.color }}>
                  <span className="tajweed-legend-dot" style={{ backgroundColor: rule.color, color: rule.color }} />
                  {rule.nameAr}
                </span>
                {rule.durationAr && (
                  <span className="mb-1.5 inline-block rounded-full border border-gold/40 px-2 py-0.5 text-[10px] font-bold text-gold">
                    المقدار: {rule.durationAr}
                  </span>
                )}
                <span className="block text-xs leading-relaxed text-muted">{rule.description}</span>
              </div>,
              document.body,
            )}
          </span>
        )
      })}
    </span>
  )
}
