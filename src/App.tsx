import { Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { HomePage } from './pages/HomePage'
import { LessonsPage } from './pages/LessonsPage'
import { LessonDetailPage } from './pages/LessonDetailPage'
import { QuranPage } from './pages/QuranPage'
import { PracticePage } from './pages/PracticePage'
import { ProgressPage } from './pages/ProgressPage'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/lessons" element={<LessonsPage />} />
        <Route path="/lessons/:ruleId" element={<LessonDetailPage />} />
        <Route path="/quran" element={<QuranPage />} />
        <Route path="/quran/:surahNumber" element={<QuranPage />} />
        <Route path="/practice" element={<PracticePage />} />
        <Route path="/progress" element={<ProgressPage />} />
      </Route>
    </Routes>
  )
}
