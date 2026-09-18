import type { TajweedRuleId, TajweedSegment } from '../types/quran'

/** api.alquran.cloud `quran-tajweed` edition single-letter rule codes → rule ids. */
const LETTER_TO_RULE: Record<string, TajweedRuleId> = {
  h: 'ham_wasl',
  s: 'slnt',
  l: 'laam_shamsiyah',
  n: 'madda_normal',
  m: 'madda_permissible',
  p: 'madda_necessary',
  o: 'madda_obligatory',
  q: 'qalqalah',
  c: 'ikhafa',
  f: 'ikhafa_shafawi',
  e: 'ikhafa_shafawi',
  w: 'idgham_shafawi',
  i: 'idgham_ghunnah',
  a: 'idgham_wo_ghunnah',
  d: 'idgham_wo_ghunnah',
  b: 'idgham_wo_ghunnah',
  u: 'iqlab',
  g: 'ghunnah',
}

const MARKUP_RE = /\[([a-z]+)(?::\d+)?\[([^\]]*)\]\]?/gi

/** Parses the Islamic Network (api.alquran.cloud) tajweed markup, e.g. `بِسْمِ [h:1[ٱ]للَّهِ`. */
export function parseTajweedMarkup(raw: string): TajweedSegment[] {
  const segments: TajweedSegment[] = []
  let last = 0
  for (const match of raw.matchAll(MARKUP_RE)) {
    const index = match.index ?? 0
    if (index > last) segments.push({ text: raw.slice(last, index) })
    const rule = LETTER_TO_RULE[match[1].toLowerCase()]
    segments.push(rule ? { text: match[2], rule } : { text: match[2] })
    last = index + match[0].length
  }
  if (last < raw.length) segments.push({ text: raw.slice(last) })
  return segments.filter((s) => s.text.length > 0)
}

/** Plain text (no markup) reconstructed from tajweed markup, for search/comparison. */
export function stripTajweedMarkup(raw: string): string {
  return raw.replace(MARKUP_RE, '$2')
}

export interface TajweedRuleInfo {
  id: TajweedRuleId
  category: 'noon_meem' | 'madd' | 'qalqalah' | 'ghunnah' | 'lam' | 'other'
  nameAr: string
  nameEn: string
  color: string
  description: string
  letters?: string
  example?: string
}

export const TAJWEED_RULES: TajweedRuleInfo[] = [
  {
    id: 'ghunnah',
    category: 'ghunnah',
    nameAr: 'الغُنّة',
    nameEn: 'Ghunnah',
    color: 'var(--tw-ghunnah)',
    description:
      'صوت أغن يخرج من الخيشوم عند النون والميم المشددتين، ويُمد بمقدار حركتين، وهي أصل تقوم عليها كثير من أحكام النون والميم الساكنتين.',
    letters: 'نّ / مّ',
  },
  {
    id: 'idgham_ghunnah',
    category: 'noon_meem',
    nameAr: 'الإدغام بغُنّة',
    nameEn: 'Idghām with Ghunnah',
    color: 'var(--tw-idgham_ghunnah)',
    description:
      'إذا جاء بعد النون الساكنة أو التنوين أحد حروف (ينمو) في كلمة أخرى، تُدغم النون في الحرف الذي بعدها مع بقاء صفة الغنة.',
    letters: 'ي ن م و',
    example: 'مَنْ يَقُولُ',
  },
  {
    id: 'idgham_wo_ghunnah',
    category: 'noon_meem',
    nameAr: 'الإدغام بغير غُنّة',
    nameEn: 'Idghām without Ghunnah',
    color: 'var(--tw-idgham_wo_ghunnah)',
    description:
      'إذا جاء بعد النون الساكنة أو التنوين حرف اللام أو الراء، تُدغم فيه إدغامًا كاملًا دون غنة.',
    letters: 'ل ر',
    example: 'مِنْ رَبِّهِمْ',
  },
  {
    id: 'iqlab',
    category: 'noon_meem',
    nameAr: 'الإقلاب',
    nameEn: 'Iqlāb',
    color: 'var(--tw-iqlab)',
    description:
      'إذا جاء حرف الباء بعد النون الساكنة أو التنوين، تُقلب النون ميمًا مخفاة مع الغنة قبل الباء.',
    letters: 'ب',
    example: 'مِنْ بَعْدِ',
  },
  {
    id: 'ikhafa',
    category: 'noon_meem',
    nameAr: 'الإخفاء الحقيقي',
    nameEn: 'Ikhfā’',
    color: 'var(--tw-ikhafa)',
    description:
      'إذا جاء بعد النون الساكنة أو التنوين أحد الحروف الخمسة عشر الباقية، تُنطق النون مخفاة بين الإظهار والإدغام مع غنة.',
    letters: 'ت ث ج د ذ ز س ش ص ض ط ظ ف ق ك',
    example: 'مِنْ كُلِّ',
  },
  {
    id: 'ikhafa_shafawi',
    category: 'noon_meem',
    nameAr: 'الإخفاء الشفوي',
    nameEn: 'Ikhfā’ Shafawī',
    color: 'var(--tw-ikhafa_shafawi)',
    description: 'إذا جاء حرف الباء بعد الميم الساكنة، تُخفى الميم مع الغنة (إخفاء شفوي).',
    letters: 'ب',
    example: 'تَرْمِيهِمْ بِحِجَارَةٍ',
  },
  {
    id: 'idgham_shafawi',
    category: 'noon_meem',
    nameAr: 'الإدغام الشفوي / إظهار شفوي',
    nameEn: 'Idghām / Izhār Shafawī',
    color: 'var(--tw-idgham_shafawi)',
    description:
      'إذا جاء بعد الميم الساكنة ميم أخرى تُدغمان مع غنة، وإذا جاء أي حرف آخر غير الباء والميم تُظهر الميم من مخرجها بوضوح.',
    letters: 'م',
    example: 'لَهُمْ مَا',
  },
  {
    id: 'qalqalah',
    category: 'qalqalah',
    nameAr: 'القلقلة',
    nameEn: 'Qalqalah',
    color: 'var(--tw-qalqalah)',
    description:
      'اضطراب واهتزاز في الحرف الساكن عند النطق به حتى يُسمع له نبرة قوية، وحروفها مجموعة في (قطب جد).',
    letters: 'ق ط ب ج د',
    example: 'يَخْلُقُ',
  },
  {
    id: 'madda_normal',
    category: 'madd',
    nameAr: 'المد الطبيعي',
    nameEn: 'Madd Ṭabī‘ī (Natural)',
    color: 'var(--tw-madda_normal)',
    description: 'مد بمقدار حركتين لا يقوم بذاته إلا به، ولا سبب له من همز أو سكون.',
    letters: 'ا و ي',
    example: 'قَالُوا',
  },
  {
    id: 'madda_permissible',
    category: 'madd',
    nameAr: 'المد الجائز المنفصل',
    nameEn: 'Madd Jā’iz Munfaṣil',
    color: 'var(--tw-madda_permissible)',
    description:
      'إذا وقع حرف المد في آخر كلمة والهمز في أول الكلمة التي تليها، ويُمد بمقدار 2 أو 4 أو 5 حركات.',
    example: 'يَا أَيُّهَا',
  },
  {
    id: 'madda_necessary',
    category: 'madd',
    nameAr: 'المد الواجب المتصل',
    nameEn: 'Madd Wājib Muttaṣil',
    color: 'var(--tw-madda_necessary)',
    description:
      'إذا وقع حرف المد والهمز في كلمة واحدة، ويجب مده بمقدار 4 أو 5 حركات وصلًا ووقفًا.',
    example: 'السَّمَاءِ',
  },
  {
    id: 'madda_obligatory',
    category: 'madd',
    nameAr: 'المد اللازم',
    nameEn: 'Madd Lāzim',
    color: 'var(--tw-madda_obligatory)',
    description: 'إذا جاء بعد حرف المد سكون أصلي (ثابت وصلًا ووقفًا)، ويُمد وجوبًا 6 حركات.',
    example: 'الضَّالِّينَ',
  },
  {
    id: 'laam_shamsiyah',
    category: 'lam',
    nameAr: 'اللام الشمسية',
    nameEn: 'Lām Shamsiyyah',
    color: 'var(--tw-laam_shamsiyah)',
    description:
      'لام "أل" التعريف تُدغم في الحرف الشمسي الذي يليها فلا تُنطق، وتُشدَّد الحرف الذي بعدها.',
    example: 'الشَّمْسُ',
  },
  {
    id: 'ham_wasl',
    category: 'other',
    nameAr: 'همزة الوصل',
    nameEn: 'Hamzat al-Waṣl',
    color: 'var(--tw-ham_wasl)',
    description: 'همزة زائدة يُتوصل بها للنطق بالساكن، تُنطق ابتداءً وتسقط وصلًا في درج الكلام.',
    example: 'ٱدْخُلُوا',
  },
  {
    id: 'slnt',
    category: 'other',
    nameAr: 'حرف ساكن مهمل (لا يُنطق)',
    nameEn: 'Silent Letter',
    color: 'var(--tw-slnt)',
    description: 'حرف مكتوب في رسم المصحف ولا يُنطق أثناء التلاوة.',
    example: 'لَا أَوْضَعُوا',
  },
]

export const TAJWEED_RULE_MAP: Record<TajweedRuleId, TajweedRuleInfo> = Object.fromEntries(
  TAJWEED_RULES.map((r) => [r.id, r]),
) as Record<TajweedRuleId, TajweedRuleInfo>

export interface WordWithRules {
  word: string
  rules: TajweedRuleId[]
}

/** Reconstructs per-word tajweed rule coverage from a segment list (segments can split mid-word). */
export function segmentsToWords(segments: TajweedSegment[]): WordWithRules[] {
  const words: WordWithRules[] = []
  let currentWord = ''
  let currentRules = new Set<TajweedRuleId>()

  const flush = () => {
    if (currentWord.length > 0) words.push({ word: currentWord, rules: [...currentRules] })
    currentWord = ''
    currentRules = new Set()
  }

  for (const seg of segments) {
    const parts = seg.text.split(/(\s+)/)
    for (const part of parts) {
      if (part === '') continue
      if (/^\s+$/.test(part)) {
        flush()
      } else {
        currentWord += part
        if (seg.rule) currentRules.add(seg.rule)
      }
    }
  }
  flush()
  return words
}

const LOW_SALIENCE_RULES = new Set<TajweedRuleId>(['ham_wasl', 'laam_shamsiyah', 'slnt'])

/** Picks the most visually informative rule to represent a word carrying several
 * (e.g. hamzat-wasl + laam-shamsiyah), preferring madd/qalqalah/ghunnah/noon-meem
 * rules over the mostly-structural/silent ones. */
export function primaryRule(rules: TajweedRuleId[]): TajweedRuleId | undefined {
  if (rules.length === 0) return undefined
  return rules.find((r) => !LOW_SALIENCE_RULES.has(r)) ?? rules[0]
}

export const TAJWEED_CATEGORIES: { id: TajweedRuleInfo['category']; nameAr: string }[] = [
  { id: 'noon_meem', nameAr: 'أحكام النون الساكنة والتنوين والميم الساكنة' },
  { id: 'madd', nameAr: 'أحكام المدود' },
  { id: 'qalqalah', nameAr: 'القلقلة' },
  { id: 'ghunnah', nameAr: 'الغنة' },
  { id: 'lam', nameAr: 'اللامات' },
  { id: 'other', nameAr: 'أحكام أخرى' },
]
