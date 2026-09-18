type IconProps = { className?: string }

const common = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
}

export function HomeIcon({ className }: IconProps) {
  return (
    <svg {...common} className={className} aria-hidden>
      <path d="M3.5 10.5 12 3.5l8.5 7" />
      <path d="M5.5 9v10.5a1 1 0 0 0 1 1H9.5v-6h5v6h3a1 1 0 0 0 1-1V9" />
    </svg>
  )
}

export function LessonsIcon({ className }: IconProps) {
  return (
    <svg {...common} className={className} aria-hidden>
      <path d="M12 6.5C10.2 5 7.3 4.4 4.5 5v13c2.8-.6 5.7 0 7.5 1.5" />
      <path d="M12 6.5C13.8 5 16.7 4.4 19.5 5v13c-2.8-.6-5.7 0-7.5 1.5" />
      <path d="M12 6.5v14" />
    </svg>
  )
}

export function QuranIcon({ className }: IconProps) {
  return (
    <svg {...common} className={className} aria-hidden>
      <path d="M12 7c-2.6-1.5-5.8-1.85-8.4-.95a.5.5 0 0 0-.35.5v10.5c0 .35.3.6.65.5A11 11 0 0 1 12 18" />
      <path d="M12 7c2.6-1.5 5.8-1.85 8.4-.95a.5.5 0 0 1 .35.5v10.5c0 .35-.3.6-.65.5A11 11 0 0 0 12 18" />
      <path d="M12 7v11" />
    </svg>
  )
}

export function PracticeIcon({ className }: IconProps) {
  return (
    <svg {...common} className={className} aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3M9 21h6" />
    </svg>
  )
}

export function ProgressIcon({ className }: IconProps) {
  return (
    <svg {...common} className={className} aria-hidden>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  )
}
