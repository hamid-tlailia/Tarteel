export type TajweedRuleId =
  // Marked directly by the alquran.cloud `quran-tajweed` edition.
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
  | 'idgham_mutajanisayn'
  | 'idgham_mutaqaribayn'
  | 'iqlab'
  | 'ghunnah'
  // Derived from the Uthmani script itself — see uthmaniRules.ts. The edition only marks
  // rules that *change* a sound, so the rules below (which leave it plain, or which apply
  // only when stopping) carry no markup and have to be worked out from the text.
  | 'izhar_halqi'
  | 'izhar_shafawi'
  | 'madda_badal'
  | 'madda_sila_sughra'
  | 'madda_sila_kubra'
  | 'madda_leen'
  | 'madda_arid'
  | 'madda_iwad'
  | 'ra_mufakhkhama'
  | 'ra_muraqqaqa'
  | 'ra_wajhan'
  | 'lam_jalalah_mufakhkhama'
  | 'lam_jalalah_muraqqaqa'
  | 'istila'

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
