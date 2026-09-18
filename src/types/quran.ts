export type TajweedRuleId =
  | 'ham_wasl'
  | 'laam_shamsiyah'
  | 'slnt'
  | 'madda_normal'
  | 'madda_permissible'
  | 'madda_necessary'
  | 'madda_obligatory'
  | 'qalqalah'
  | 'ikhafa'
  | 'ikhafa_shafawi'
  | 'idgham_shafawi'
  | 'idgham_ghunnah'
  | 'idgham_wo_ghunnah'
  | 'iqlab'
  | 'ghunnah'

export interface TajweedSegment {
  text: string
  rule?: TajweedRuleId
}

export interface SurahMeta {
  number: number
  name: string
  englishName: string
  englishNameTranslation: string
  revelationType: 'Meccan' | 'Medinan'
  numberOfAyahs: number
}

export interface Ayah {
  number: number
  numberInSurah: number
  surah: number
  text: string
  segments: TajweedSegment[]
  audioUrl: string
}
