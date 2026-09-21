import type { TajweedRuleId, TajweedSegment } from '../types/quran'

/**
 * api.alquran.cloud `quran-tajweed` edition single-letter rule codes → rule ids.
 *
 * Verified against the official alquran.cloud Tajweed Guide (alquran.cloud/tajweed-guide),
 * the islamic-network/alquran.tools reference implementation, and live API payloads
 * (e.g. `[i[ِنۢ ب]` in مِنْۢ بَعْدِ = iqlāb, `[a[ةٌ و]` in سِنَةٌ وَلَا = idghām with ghunnah,
 * `[u[مٌ ل]` in نَوْمٌ لَّهُ = idghām without ghunnah, `[d[ت]` in أَثْقَلَت دَّعَوَا = mutajānisayn,
 * `[b[ق]` in نَخْلُقكُّمْ = mutaqāribayn, `[m[َا]` in الضَّآلِّينَ = madd lāzim).
 */
const LETTER_TO_RULE: Record<string, TajweedRuleId> = {
  h: 'ham_wasl',
  s: 'slnt',
  l: 'laam_shamsiyah',
  n: 'madda_normal',
  p: 'madda_permissible',
  m: 'madda_necessary',
  o: 'madda_obligatory',
  q: 'qalqalah',
  c: 'ikhafa_shafawi',
  f: 'ikhafa',
  w: 'idgham_shafawi',
  i: 'iqlab',
  a: 'idgham_ghunnah',
  u: 'idgham_wo_ghunnah',
  d: 'idgham_mutajanisayn',
  b: 'idgham_mutaqaribayn',
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
  category: 'noon_meem' | 'idgham_types' | 'madd' | 'qalqalah' | 'ghunnah' | 'lam' | 'other'
  nameAr: string
  nameEn: string
  color: string
  description: string
  letters?: string
  /** Length of the rule's effect in ḥarakāt, when it has a fixed duration (madd, ghunnah…). */
  durationAr?: string
  example?: string
}

export const TAJWEED_RULES: TajweedRuleInfo[] = [
  {
    id: 'ghunnah',
    category: 'ghunnah',
    nameAr: 'الغُنّة',
    nameEn: 'Ghunnah',
    color: 'var(--tw-ghunnah)',
    durationAr: 'حركتان',
    description:
      'صوت أغنّ لذيذ يخرج من الخيشوم (أعلى الأنف) لا دخل للسان فيه، يصاحب النون والميم المشددتين بمقدار حركتين، ولا تنفكّان عنها أبدًا، وهي أصل تقوم عليه أحكام النون والميم الساكنتين والتنوين.',
    letters: 'نّ / مّ',
    example: 'إِنَّ · فَلَمَّا',
  },
  {
    id: 'idgham_ghunnah',
    category: 'noon_meem',
    nameAr: 'الإدغام بغُنّة',
    nameEn: 'Idghām with Ghunnah',
    color: 'var(--tw-idgham_ghunnah)',
    durationAr: 'حركتان',
    description:
      'إذا جاء بعد النون الساكنة أو التنوين أحد حروف (يَرْمَلُون) الأربعة: الياء والنون والميم والواو، في أول الكلمة التالية، تُدغم النون في ذلك الحرف ويصيران حرفًا واحدًا مشددًا مع بقاء الغُنّة بمقدار حركتين.',
    letters: 'ي ن م و',
    example: 'مَن يَّقُولُ · سِنَةٌ وَلَا',
  },
  {
    id: 'idgham_wo_ghunnah',
    category: 'noon_meem',
    nameAr: 'الإدغام بغير غُنّة',
    nameEn: 'Idghām without Ghunnah',
    color: 'var(--tw-idgham_wo_ghunnah)',
    description:
      'إذا جاء بعد النون الساكنة أو التنوين حرف اللام أو الراء في أول الكلمة التالية، تُدغم فيهما إدغامًا كاملًا بلا غُنّة، فيُشدَّد الحرف الثاني ويعتمد عليه اللسان مباشرة.',
    letters: 'ل ر',
    example: 'مِن رَّبِّهِمْ · نَوْمٌ لَّهُ',
  },
  {
    id: 'iqlab',
    category: 'noon_meem',
    nameAr: 'الإقلاب',
    nameEn: 'Iqlāb',
    color: 'var(--tw-iqlab)',
    durationAr: 'حركتان',
    description:
      'إذا جاء حرف الباء بعد النون الساكنة أو التنوين، تُقلب النون ميمًا مخفاة مع الغُنّة بمقدار حركتين، وعلامة ذلك في رسم المصحف ميم صغيرة (مِۢنۢ) تنبيهًا على القلب.',
    letters: 'ب',
    example: 'مِنۢ بَعْدِ · أَنۢبِئْهُم',
  },
  {
    id: 'ikhafa',
    category: 'noon_meem',
    nameAr: 'الإخفاء الحقيقي',
    nameEn: 'Ikhfāʾ',
    color: 'var(--tw-ikhafa)',
    durationAr: 'حركتان',
    description:
      'إذا جاء بعد النون الساكنة أو التنوين واحد من الحروف الخمسة عشر الباقية، تُنطق النون مخفاةً بين الإظهار والإدغام — بلا تشديد — مع غُنّة بمقدار حركتين، وهي أكثر أحكام النون الساكنة وقوعًا في القرآن.',
    letters: 'ت ث ج د ذ ز س ش ص ض ط ظ ف ق ك',
    example: 'يَنقُضُونَ · مَن ذَا · مِن كُلِّ',
  },
  {
    id: 'ikhafa_shafawi',
    category: 'noon_meem',
    nameAr: 'الإخفاء الشفوي',
    nameEn: 'Ikhfāʾ Shafawī',
    color: 'var(--tw-ikhafa_shafawi)',
    durationAr: 'حركتان',
    description:
      'إذا جاء حرف الباء بعد الميم الساكنة، تُخفى الميم عند الشفتين مع بقاء الغُنّة بمقدار حركتين، ويسمى شفويًا لأن مخرج الميم والباء من الشفتين.',
    letters: 'مْ + ب',
    example: 'تَرْمِيهِم بِحِجَارَةٍ',
  },
  {
    id: 'idgham_shafawi',
    category: 'noon_meem',
    nameAr: 'الإدغام الشفوي (المِثْلان الصغيران)',
    nameEn: 'Idghām Shafawī',
    color: 'var(--tw-idgham_shafawi)',
    durationAr: 'حركتان',
    description:
      'إذا جاءت ميم ساكنة بعدها ميم متحركة، تُدغم الميم الأولى في الثانية فيصيران ميمًا واحدة مشددة، مع غُنّة كاملة بمقدار حركتين. ويسمى شفويًا لأن الميم تخرج من الشفتين.',
    letters: 'مْ + م',
    example: 'لَهُم مَّا · أَطْعَمَهُم مِّنْ',
  },
  {
    id: 'idgham_mutajanisayn',
    category: 'idgham_types',
    nameAr: 'إدغام المتجانسين',
    nameEn: 'Idghām Mutajānisayn',
    color: 'var(--tw-idgham_mutajanisayn)',
    description:
      'إذا التقى حرفان اتحدا في المخرج واختلفا في بعض الصفات، وكان الأول ساكنًا، أُدغم الأول في الثاني وصار النطق بالحرف الثاني مشددًا — وذلك في: التاء مع الطاء والدال، والدال مع التاء، والثاء مع الذال والتاء، والباء مع الميم.',
    letters: 'ت→ط · ت→د · د→ت · ث→ذ · ب→م',
    example: 'أَثْقَلَت دَّعَوَا · أُجِيبَت دَّعْوَتُكُمَا',
  },
  {
    id: 'idgham_mutaqaribayn',
    category: 'idgham_types',
    nameAr: 'إدغام المتقاربين',
    nameEn: 'Idghām Mutaqāribayn',
    color: 'var(--tw-idgham_mutaqaribayn)',
    description:
      'إذا التقى حرفان تقاربا في المخرج والصفة، وكان الأول ساكنًا، أُدغم الأول في الثاني — وأشهر مواضعه في رواية حفص: القاف الساكنة مع الكاف، واللام الساكنة مع الراء.',
    letters: 'ق→ك · ل→ر',
    example: 'أَلَمْ نَخْلُقكُّمْ',
  },
  {
    id: 'qalqalah',
    category: 'qalqalah',
    nameAr: 'القلقلة',
    nameEn: 'Qalqalah',
    color: 'var(--tw-qalqalah)',
    description:
      'اهتزاز وارتعاد في صوت الحرف الساكن حتى يُسمع له نبرة قوية واضحة، وحروفها مجموعة في (قُطْبُ جَدٍّ)، وتكون صغرى إذا وقع الحرف ساكنًا في وسط الكلمة، وكبرى — وهي أقوى — إذا جاء مشددًا أو في آخر الكلمة عند الوقف.',
    letters: 'ق ط ب ج د',
    example: 'لَمْ يَلِدْ · أَحَدٌۢ',
  },
  {
    id: 'madda_normal',
    category: 'madd',
    nameAr: 'المد العادي (الطبيعي)',
    nameEn: 'Madd Normal',
    color: 'var(--tw-madda_normal)',
    durationAr: 'حركتان',
    description:
      'مدٌّ بمقدار حركتين لا تقوم ذات الحرف إلا به، ولا يقع بعد حرف المد همز ولا سكون. ويُلَوَّن بهذا اللون في رسم المصحف العثماني: الألف الخنجرية (ــٰــ)، وواو الصلة وياءها الصغيرتان (هٰ، هِۦ) اللتان تُمدّان حركتين.',
    letters: 'ــٰــ · ۥ · ۦ',
    example: 'الرَّحْمَٰنِ · تَأْخُذُهُۥ',
  },
  {
    id: 'madda_permissible',
    category: 'madd',
    nameAr: 'المد الجائز (حروف المدّ واللِّين)',
    nameEn: 'Madd Permissible',
    color: 'var(--tw-madda_permissible)',
    durationAr: 'حركتان — و2 أو 4 أو 6 وقفًا',
    description:
      'حروف المد المكتوبة (الألف والواو والياء) تُمد طبيعيًا حركتين كما في الرَّحِيم والفِيل، ويلحق بها مدُّ اللِّين عند الوقف — الواو والياء الساكنتان المفتوح ما قبلهما كما في خَوْف وقُرَيْش — ويجوز في اللين المدُّ حركتين أو أربعًا أو ستًا.',
    letters: 'ا و ي',
    example: 'الرَّحِيمِ · خَوْف · قُرَيْشٍ',
  },
  {
    id: 'madda_obligatory',
    category: 'madd',
    nameAr: 'المد الواجب (المتصل والمنفصل)',
    nameEn: 'Madd Obligatory',
    color: 'var(--tw-madda_obligatory)',
    durationAr: '4 أو 5 حركات',
    description:
      'يُمد أربع أو خمس حركات في موضعين: المتصل — أن يجتمع حرف المد والهمز في كلمة واحدة كالسماء وجاء؛ والمنفصل — أن يقع حرف المد في آخر كلمة والهمز في أول التالية كـ(لَآ إِلَٰهَ)، ويلحق به مدُّ صلة الهاء الكبرى قبل الهمز.',
    example: 'السَّمَاءِ · لَآ إِلَٰهَ · بِإِذْنِهِۦٓ',
  },
  {
    id: 'madda_necessary',
    category: 'madd',
    nameAr: 'المد اللازم',
    nameEn: 'Madd Necessary',
    color: 'var(--tw-madda_necessary)',
    durationAr: '6 حركات',
    description:
      'إذا جاء بعد حرف المد سكون أصلي ثابت في الوصل والوقف، وجب مدّه ست حركات بالإجماع — وهو نوعان: كلميٌّ مثقَّل كـ(الضَّآلِّين) ومخفَّف كـ(ءَآلۡـَٰٔنَ)، وحرفيٌّ في فواتح بعض السور.',
    example: 'الضَّآلِّينَ',
  },
  {
    id: 'laam_shamsiyah',
    category: 'lam',
    nameAr: 'اللام الشمسية',
    nameEn: 'Lām Shamsiyyah',
    color: 'var(--tw-laam_shamsiyah)',
    description:
      'لام «أل» لا تُنطق وتُدغم في الحرف الشمسي الذي يليها، فيُشدَّد ذلك الحرف وتُكتب اللام في المصحف دون تشديد. وحروفها أربعة عشر، والحرف الشمسي يُعرف بوضع الشدة عليه.',
    letters: 'ت ث د ذ ر ز س ش ص ض ط ظ ل ن',
    example: 'الشَّمْسُ · الرَّحْمَٰنِ',
  },
  {
    id: 'ham_wasl',
    category: 'other',
    nameAr: 'همزة الوصل',
    nameEn: 'Hamzat al-Waṣl',
    color: 'var(--tw-ham_wasl)',
    description:
      'ألف زائدة يُتوصَّل بها إلى النطق بالساكن بعدها، تُنطق مفتوحة أو مضمومة أو مكسورة عند الابتداء بالكلمة، وتسقط تمامًا في درج الكلام (الوصل)، وعلامتها في المصحف ألف فوقها صادة صغيرة (ٱ).',
    example: 'ٱدْخُلُوا · ٱسْمُ',
  },
  {
    id: 'slnt',
    category: 'other',
    nameAr: 'حرف لا يُنطق (صامت)',
    nameEn: 'Silent Letter',
    color: 'var(--tw-slnt)',
    description:
      'حرف مرسوم في خط المصحف العثماني ولا يُنطق حال التلاوة — مثل واو (أُولَئِكَ) وألف (فَلْيَعْبُدُوا) الزائدة في الرسم، ولام (ٱلْحَمْدُ) عند الوصل.',
    example: 'أُولَئِكَ · فَلْيَعْبُدُوا',
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
  { id: 'idgham_types', nameAr: 'الإدغام المتجانس والمتقارب' },
  { id: 'madd', nameAr: 'أحكام المدود' },
  { id: 'qalqalah', nameAr: 'القلقلة' },
  { id: 'ghunnah', nameAr: 'الغُنّة' },
  { id: 'lam', nameAr: 'أحكام اللام' },
  { id: 'other', nameAr: 'أحكام أخرى' },
]
