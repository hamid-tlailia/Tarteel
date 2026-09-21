import { create } from 'zustand'

export type ThemeId = 'ivory' | 'night' | 'mushaf' | 'royal'

export interface ThemeMeta {
  id: ThemeId
  nameAr: string
  nameEn: string
  /** Two-color swatch shown in the theme picker. */
  swatch: [string, string]
  /** Browser chrome color reported via <meta name="theme-color">. */
  metaColor: string
  dark: boolean
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'ivory',
    nameAr: 'العاجي الذهبي',
    nameEn: 'Ivory Gold',
    swatch: ['#f7f2e8', '#ab8734'],
    metaColor: '#f7f2e8',
    dark: false,
  },
  {
    id: 'night',
    nameAr: 'ليل الزمرد',
    nameEn: 'Emerald Night',
    swatch: ['#0b1a13', '#3ddba2'],
    metaColor: '#06110d',
    dark: true,
  },
  {
    id: 'mushaf',
    nameAr: 'ورق المصحف',
    nameEn: 'Mushaf Parchment',
    swatch: ['#f2e7cd', '#9a742f'],
    metaColor: '#f2e7cd',
    dark: false,
  },
  {
    id: 'royal',
    nameAr: 'الليل الملكي',
    nameEn: 'Royal Midnight',
    swatch: ['#0d1428', '#dcc078'],
    metaColor: '#070c1c',
    dark: true,
  },
]

export const THEME_STORAGE_KEY = 'wartil-theme'

const DARK_THEMES = new Set<ThemeId>(['night', 'royal'])

function applyTheme(theme: ThemeId) {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.setAttribute('data-dark', DARK_THEMES.has(theme) ? 'true' : 'false')
  const meta = THEMES.find((t) => t.id === theme)
  const metaTag = document.querySelector('meta[name="theme-color"]')
  if (meta && metaTag) metaTag.setAttribute('content', meta.metaColor)
}

function readInitialTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null
    if (stored && THEMES.some((t) => t.id === stored)) return stored
  } catch {
    /* storage unavailable — fall through to system preference */
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'ivory'
}

interface ThemeState {
  theme: ThemeId
  setTheme: (theme: ThemeId) => void
}

export const useThemeStore = create<ThemeState>((set) => {
  const initial = readInitialTheme()
  applyTheme(initial) // keep in sync with the pre-paint inline script in index.html
  return {
    theme: initial,
    setTheme: (theme) => {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme)
      } catch {
        /* non-fatal */
      }
      applyTheme(theme)
      set({ theme })
    },
  }
})
