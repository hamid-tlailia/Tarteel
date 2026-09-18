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
  accuracy: number
  correct: number
  total: number
}

interface ProgressState {
  attempts: PracticeAttempt[]
  completedLessons: TajweedRuleId[]
  addAttempt: (attempt: PracticeAttempt) => void
  markLessonComplete: (rule: TajweedRuleId) => void
  isLessonComplete: (rule: TajweedRuleId) => boolean
  streakDays: () => number
}

export const useProgressStore = create<ProgressState>()(
  persist(
    (set, get) => ({
      attempts: [],
      completedLessons: [],
      addAttempt: (attempt) => set((s) => ({ attempts: [...s.attempts, attempt].slice(-200) })),
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
    { name: 'tarteel-progress' },
  ),
)
