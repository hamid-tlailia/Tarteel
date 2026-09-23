/**
 * Which riwāya the app is judging by — declared, not assumed.
 *
 * Everything that decides whether a recitation is correct here is specific to one riwāya:
 * the muṣḥaf text and its tajweed markup come from a Ḥafṣ edition, the rules derived from
 * the script in uthmaniRules.ts encode Ḥafṣ's wujūh, the madd measures in recitationPace.ts
 * are the ones Ḥafṣ's ṭarīq permits, and every reference recitation offered is a Ḥafṣ
 * reading. A Warsh reading of the same ayah differs in the text itself, in which madds are
 * owed and in how long they are held — so grading one against this engine would not be a
 * strict judgement, it would be a wrong one.
 *
 * The other riwāyāt are therefore listed and refused rather than silently mis-measured. A
 * learner who reads by Warsh is told plainly that the app cannot yet judge their reading,
 * which is the only honest thing to say and far better than a number that means nothing.
 */

export type RiwayaId = 'hafs' | 'warsh' | 'qalun' | 'aldouri'

export interface Riwaya {
  id: RiwayaId
  nameAr: string
  /** The qārīʾ this riwāya is transmitted from. */
  viaAr: string
  /** Whether this build can actually judge a reading in it. */
  supported: boolean
  noteAr: string
}

export const RIWAYAT: Riwaya[] = [
  {
    id: 'hafs',
    nameAr: 'حفص',
    viaAr: 'عن عاصم',
    supported: true,
    noteAr: 'الرواية التي يقوم عليها التقييم: النص والأحكام والمقادير كلها على طريق حفص من الشاطبية.',
  },
  {
    id: 'warsh',
    nameAr: 'ورش',
    viaAr: 'عن نافع',
    supported: false,
    noteAr: 'غير مدعومة بعد — تختلف في الرسم والمدود والأوجه، فلا يصحّ قياسها بمقادير حفص.',
  },
  {
    id: 'qalun',
    nameAr: 'قالون',
    viaAr: 'عن نافع',
    supported: false,
    noteAr: 'غير مدعومة بعد — تحتاج نصًّا وأحكامًا خاصّة بها.',
  },
  {
    id: 'aldouri',
    nameAr: 'الدُّوري',
    viaAr: 'عن أبي عمرو',
    supported: false,
    noteAr: 'غير مدعومة بعد — تحتاج نصًّا وأحكامًا خاصّة بها.',
  },
]

export const DEFAULT_RIWAYA_ID: RiwayaId = 'hafs'

const BY_ID = new Map(RIWAYAT.map((r) => [r.id, r]))

export function riwayaOf(id: RiwayaId | undefined | null): Riwaya {
  return BY_ID.get(id ?? DEFAULT_RIWAYA_ID) ?? BY_ID.get(DEFAULT_RIWAYA_ID)!
}

/** The full name, as a reciter would say it. */
export function riwayaFullNameAr(id: RiwayaId | undefined | null): string {
  const r = riwayaOf(id)
  return `${r.nameAr} ${r.viaAr}`
}
