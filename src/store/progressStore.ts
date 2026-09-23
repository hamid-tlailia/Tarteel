import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TajweedRuleId } from '../types/quran'

export interface PracticeAttempt {
  id: string
  date: string
  surah: number
  surahName: string
  ayahFrom: number
  ayahTo: number
  /** Words said as written, out of the words reached. A text result, not a tajweed one. */
  accuracy: number
  correct: number
  total: number
  /**
   * What became of the tajweed rulings in that attempt — counted, never averaged with the
   * words. Optional because attempts recorded before the app could tell these apart have no
   * honest value to put here, and inventing one would be worse than leaving it out.
   */
  rulings?: { met: number; faulted: number; undecided: number }
  /** Which rulings came back faulted, so the progress page can say what to go back to. */
  faultedRules?: TajweedRuleId[]
  /** And which were actually verified, so "practised" is not confused with "attempted". */
  metRules?: TajweedRuleId[]
}

/** Where the reader stopped, so the muṣḥaf can offer to carry on rather than start over. */
export interface ReadingPosition {
  surah: number
  surahName: string
  ayah: number
  date: string
}

interface ProgressState {
  attempts: PracticeAttempt[]
  completedLessons: TajweedRuleId[]
  lastRead: ReadingPosition | null
  addAttempt: (attempt: PracticeAttempt) => void
  setLastRead: (position: ReadingPosition) => void
  clearLastRead: () => void
  markLessonComplete: (rule: TajweedRuleId) => void
  isLessonComplete: (rule: TajweedRuleId) => boolean
  streakDays: () => number
}

export const useProgressStore = create<ProgressState>()(
  persist(
    (set, get) => ({
      attempts: [],
      completedLessons: [],
      lastRead: null,
      addAttempt: (attempt) => set((s) => ({ attempts: [...s.attempts, attempt].slice(-200) })),
      setLastRead: (position) => set({ lastRead: position }),
      clearLastRead: () => set({ lastRead: null }),
      markLessonComplete: (rule) =>
        set((s) => (s.completedLessons.includes(rule) ? s : { completedLessons: [...s.completedLessons, rule] })),
      isLessonComplete: (rule) => get().completedLessons.includes(rule),
      streakDays: () => {
        const days = new Set(get().attempts.map((a) => a.date.slice(0, 10)))
        let streak = 0
        const cursor = new Date()
        for (;;) {
          const key = cursor.toISOString().slice(0, 10)
          if (!days.has(key)) break
          streak++
          cursor.setDate(cursor.getDate() - 1)
        }
        return streak
      },
    }),
    { name: 'wartil-progress' },
  ),
)
