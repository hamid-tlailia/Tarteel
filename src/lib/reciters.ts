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
 *
 * Two audio sources, for two different jobs.
 *
 * Playing a recording only needs a URL an <audio> element can load, and the Islamic Network
 * CDN does that well. *Reading its samples* is another matter: that is a cross-origin fetch,
 * and the CDN sends no Access-Control-Allow-Origin header at all, so every attempt to align
 * a reference recitation failed in the browser and the app reported «تعذّر المرجع» for every
 * reciter. everyayah.com serves the same recitations with `Access-Control-Allow-Origin: *`,
 * so the analysis reads from there while playback stays where it was.
 */
export interface Reciter {
  /** The Islamic Network edition id, used for playback. */
  id: string
  nameAr: string
  /** What this recording is good for, in one line a learner can choose by. */
  noteAr: string
  pace: PaceId
  /** The recording teachers point students at first. */
  recommended?: boolean
  /**
   * The everyayah.com folder holding the same recitation, which is what the timing analysis
   * fetches — it is the one of the two sources that permits a cross-origin read. Absent
   * where no folder serves this reciter reliably, in which case that reciter can still be
   * listened to but cannot be used as a timing reference.
   */
  analysisFolder?: string
}

export const RECITERS: Reciter[] = [
  {
    id: 'ar.husary',
    analysisFolder: 'Husary_128kbps',
    nameAr: 'محمود خليل الحُصري',
    noteAr: 'مرتَّل — المرجع الأشهر في تعليم التجويد',
    pace: 'tadweer',
    recommended: true,
  },
  {
    id: 'ar.husarymujawwad',
    analysisFolder: 'Husary_Mujawwad_64kbps',
    nameAr: 'الحُصري — مجوَّد',
    noteAr: 'تحقيق وتأنٍّ، تُشبَع فيه المدود',
    pace: 'tahqiq',
  },
  {
    id: 'ar.minshawi',
    analysisFolder: 'Minshawy_Murattal_128kbps',
    nameAr: 'محمد صدّيق المنشاوي',
    noteAr: 'مرتَّل هادئ، واضح المخارج',
    pace: 'tadweer',
  },
  {
    id: 'ar.muhammadayyoub',
    analysisFolder: 'Muhammad_Ayyoub_128kbps',
    nameAr: 'محمد أيّوب',
    noteAr: 'مرتَّل متأنٍّ، مناسب للحفظ',
    pace: 'tadweer',
  },
  {
    id: 'ar.alafasy',
    analysisFolder: 'Alafasy_128kbps',
    nameAr: 'مشاري العفاسي',
    noteAr: 'مرتَّل معاصر واسع الانتشار',
    pace: 'tadweer',
  },
  {
    id: 'ar.mahermuaiqly',
    analysisFolder: 'Maher_AlMuaiqly_64kbps',
    nameAr: 'ماهر المعيقلي',
    noteAr: 'إمام الحرم المكي — مرتَّل',
    pace: 'tadweer',
  },
  {
    id: 'ar.hudhaify',
    analysisFolder: 'Hudhaify_128kbps',
    nameAr: 'علي الحذيفي',
    noteAr: 'إمام المسجد النبوي — مرتَّل',
    pace: 'tadweer',
  },
  {
    id: 'ar.shaatree',
    analysisFolder: 'Abu_Bakr_Ash-Shaatree_128kbps',
    nameAr: 'أبو بكر الشاطري',
    noteAr: 'مرتَّل متوسط السرعة',
    pace: 'tadweer',
  },
  {
    id: 'ar.ahmedajamy',
    analysisFolder: 'Ahmed_ibn_Ali_al_Ajamy_128kbps',
    nameAr: 'أحمد بن علي العجمي',
    noteAr: 'مرتَّل، نبرة واضحة',
    pace: 'tadweer',
  },
  {
    id: 'ar.muhammadjibreel',
    analysisFolder: 'Muhammad_Jibreel_128kbps',
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
