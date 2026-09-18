import { useState } from 'react'
import type { TajweedSegment } from '../types/quran'
import { TAJWEED_RULE_MAP } from '../lib/tajweed'

interface TajweedTextProps {
  segments: TajweedSegment[]
  colored?: boolean
  className?: string
  interactive?: boolean
}

export function TajweedText({ segments, colored = true, className, interactive = true }: TajweedTextProps) {
  const [active, setActive] = useState<number | null>(null)

  return (
    <span className={className} dir="rtl">
      {segments.map((seg, i) => {
        const rule = colored ? seg.rule && TAJWEED_RULE_MAP[seg.rule] : undefined
        if (!rule) return <span key={i}>{seg.text}</span>
        return (
          <span key={i} className="relative">
            <span
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              style={{ color: rule.color }}
              className={interactive ? 'cursor-pointer underline decoration-dotted decoration-2 underline-offset-4' : undefined}
              onClick={interactive ? () => setActive(active === i ? null : i) : undefined}
              onKeyDown={
                interactive
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') setActive(active === i ? null : i)
                    }
                  : undefined
              }
            >
              {seg.text}
            </span>
            {interactive && active === i && (
              <span
                className="absolute bottom-full right-1/2 z-20 mb-2 w-56 translate-x-1/2 rounded-xl border border-brand-200 bg-white p-3 text-right text-sm font-sans leading-relaxed text-emerald-950 shadow-lg dark:border-brand-800 dark:bg-emerald-950 dark:text-brand-50"
                dir="rtl"
              >
                <span className="mb-1 flex items-center gap-2 font-bold" style={{ color: rule.color }}>
                  <span className="tajweed-legend-dot" style={{ backgroundColor: rule.color }} />
                  {rule.nameAr}
                </span>
                <span className="block text-xs opacity-80">{rule.description}</span>
              </span>
            )}
          </span>
        )
      })}
    </span>
  )
}
