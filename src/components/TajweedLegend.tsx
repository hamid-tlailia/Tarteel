import { TAJWEED_RULES } from '../lib/tajweed'

export function TajweedLegend({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex flex-wrap gap-x-4 gap-y-2.5 ${compact ? 'text-xs' : 'text-sm'}`}>
      {TAJWEED_RULES.map((rule) => (
        <span key={rule.id} className="flex items-center gap-2">
          <span
            className="tajweed-legend-dot shrink-0"
            style={{ backgroundColor: rule.color, color: rule.color }}
            aria-hidden
          />
          <span className="font-medium text-muted">{rule.nameAr}</span>
        </span>
      ))}
    </div>
  )
}
