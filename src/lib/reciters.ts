import type { PaceId } from './recitationPace'

/**
 * The reciters a learner may set as their reference.
 *
 * Every one is an accredited muqriʾ with a widely published recording, not merely a pleasant
 * voice: this list decides what the app will treat as a correct reading, so it is not the
 * place for an open catalogue. Each identifier was checked to actually serve audio for every
 * ayah from the Islamic Network CDN — several editions the API advertises (ʿAbd al-Bāsit,
 * al-Sudais, al-Shuraym among them) return AccessDenied there and are left out rather than
 * offered and then broken.
 *
 * The pace is the one that recording is read in, which matters because the app measures the
 * madds against the pace: al-Ḥuṣarī's murattal is a deliberate teaching pace, his mujawwad a
 * much slower one, and comparing a learner's ḥadr against the latter would manufacture
 * faults. Selecting a reciter therefore offers to set the pace with them.
 */
export interface Reciter {
  id: string
  nameAr: string
  /** What this recording is good for, in one line a learner can choose by. */
  noteAr: string
  pace: PaceId
  /** The recording teachers point students at first. */
  recommended?: boolean
}

export const RECITERS: Reciter[] = [
  {
    id: 'ar.husary',
    nameAr: 'محمود خليل الحُصري',
    noteAr: 'مرتَّل — المرجع الأشهر في تعليم التجويد',
    pace: 'tadweer',
    recommended: true,
  },
  {
    id: 'ar.husarymujawwad',
    nameAr: 'الحُصري — مجوَّد',
    noteAr: 'تحقيق وتأنٍّ، تُشبَع فيه المدود',
    pace: 'tahqiq',
  },
  {
    id: 'ar.minshawi',
    nameAr: 'محمد صدّيق المنشاوي',
    noteAr: 'مرتَّل هادئ، واضح المخارج',
    pace: 'tadweer',
  },
  {
    id: 'ar.muhammadayyoub',
    nameAr: 'محمد أيّوب',
    noteAr: 'مرتَّل متأنٍّ، مناسب للحفظ',
    pace: 'tadweer',
  },
  {
    id: 'ar.alafasy',
    nameAr: 'مشاري العفاسي',
    noteAr: 'مرتَّل معاصر واسع الانتشار',
    pace: 'tadweer',
  },
  {
    id: 'ar.mahermuaiqly',
    nameAr: 'ماهر المعيقلي',
    noteAr: 'إمام الحرم المكي — مرتَّل',
    pace: 'tadweer',
  },
  {
    id: 'ar.hudhaify',
    nameAr: 'علي الحذيفي',
    noteAr: 'إمام المسجد النبوي — مرتَّل',
    pace: 'tadweer',
  },
  {
    id: 'ar.shaatree',
    nameAr: 'أبو بكر الشاطري',
    noteAr: 'مرتَّل متوسط السرعة',
    pace: 'tadweer',
  },
  {
    id: 'ar.ahmedajamy',
    nameAr: 'أحمد بن علي العجمي',
    noteAr: 'مرتَّل، نبرة واضحة',
    pace: 'tadweer',
  },
  {
    id: 'ar.muhammadjibreel',
    nameAr: 'محمد جبريل',
    noteAr: 'مرتَّل، سرعة معتدلة',
    pace: 'tadweer',
  },
]

export const DEFAULT_RECITER_ID = 'ar.husary'

const BY_ID = new Map(RECITERS.map((r) => [r.id, r]))

export function reciterOf(id: string | undefined | null): Reciter {
  return BY_ID.get(id ?? DEFAULT_RECITER_ID) ?? BY_ID.get(DEFAULT_RECITER_ID)!
}
