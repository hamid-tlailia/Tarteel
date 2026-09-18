import { TAJWEED_RULES } from '../lib/tajweed'

export function TajweedLegend({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex flex-wrap gap-x-4 gap-y-2 ${compact ? 'text-xs' : 'text-sm'}`}>
      {TAJWEED_RULES.map((rule) => (
        <span key={rule.id} className="flex items-center gap-1.5">
          <span className="tajweed-legend-dot" style={{ backgroundColor: rule.color }} />
          <span className="text-emerald-900/80 dark:text-brand-100/80">{rule.nameAr}</span>
        </span>
      ))}
    </div>
  )
}
