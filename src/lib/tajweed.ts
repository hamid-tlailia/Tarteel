import type { TajweedRuleId, TajweedSegment } from '../types/quran'
import { deriveUthmaniRules } from './uthmaniRules'

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

  /* ─── Derived from the Uthmani script (see uthmaniRules.ts) ─── */

  {
    id: 'izhar_halqi',
    category: 'noon_meem',
    nameAr: 'الإظهار الحلقي',
    nameEn: 'Izhār Halqī',
    color: 'var(--tw-izhar_halqi)',
    description:
      'إذا جاء بعد النون الساكنة أو التنوين أحد حروف الحلق الستة، أُظهرت النون من مخرجها واضحةً بلا غُنّة زائدة ولا إدغام — وسُمّي حلقيًّا لأن حروفه كلها تخرج من الحلق.',
    letters: 'ء ه ع ح غ خ',
    example: 'مَنْ ءَامَنَ · عَلِيمٌ حَكِيمٌ',
  },
  {
    id: 'izhar_shafawi',
    category: 'noon_meem',
    nameAr: 'الإظهار الشفوي',
    nameEn: 'Izhār Shafawī',
    color: 'var(--tw-izhar_shafawi)',
    description:
      'الميم الساكنة إذا جاء بعدها أيّ حرف غير الباء والميم، تُنطق ظاهرةً من الشفتين بلا غُنّة زائدة. ويتأكّد إظهارها عند الواو والفاء خاصّةً لقرب مخرجيهما منها.',
    letters: 'كل الحروف عدا ب م',
    example: 'أَمْ لَمْ · لَعَلَّكُمْ تَتَّقُونَ',
  },
  {
    id: 'madda_badal',
    category: 'madd',
    nameAr: 'مَدُّ البَدَل',
    nameEn: 'Madd al-Badal',
    color: 'var(--tw-madda_badal)',
    durationAr: 'حركتان',
    description:
      'أن تتقدّم الهمزةُ على حرف المدّ في الكلمة نفسها، وسُمّي بدلًا لأن حرف المدّ فيه مُبدَل من همزة ساكنة (ءَاْمَنَ ← ءَامَنَ). ويُمدّ عند حفص حركتين كالمدّ الطبيعي.',
    letters: 'همزة + حرف مدّ',
    example: 'ءَامَنُوا · إِيمَانًا · أُوتُوا',
  },
  {
    id: 'madda_sila_sughra',
    category: 'madd',
    nameAr: 'مَدُّ الصِّلَة الصُّغْرَى',
    nameEn: 'Madd al-Silah al-Sughrā',
    color: 'var(--tw-madda_sila_sughra)',
    durationAr: 'حركتان',
    description:
      'هاء الضمير المفردة الواقعة بين متحرّكين تُوصَل وصلًا بواو إن كانت مضمومة وبياء إن كانت مكسورة، فتُمدّ حركتين. ويضبطها المصحف بواو صغيرة أو ياء صغيرة فوق الهاء.',
    letters: 'هـ الضمير بين متحركين',
    example: 'إِنَّهُۥ كَانَ · بِهِۦ بَصِيرًا',
  },
  {
    id: 'madda_sila_kubra',
    category: 'madd',
    nameAr: 'مَدُّ الصِّلَة الكُبْرَى',
    nameEn: 'Madd al-Silah al-Kubrā',
    color: 'var(--tw-madda_sila_kubra)',
    durationAr: 'أربع حركات',
    description:
      'هاء الضمير الموصولة إذا جاء بعدها همزة قطع في أول الكلمة التالية، فتُمدّ مدًّا كالمنفصل أربع حركات عند حفص — لأنها صارت حرف مدّ لقيه همزٌ في كلمة أخرى.',
    letters: 'هـ الضمير + همزة قطع',
    example: 'مَالَهُۥٓ أَخْلَدَهُۥ · عِندَهُۥٓ إِلَّا',
  },
  {
    id: 'madda_leen',
    category: 'madd',
    nameAr: 'مَدُّ اللِّين',
    nameEn: 'Madd al-Līn',
    color: 'var(--tw-madda_leen)',
    durationAr: 'حركتان (وقفًا)',
    description:
      'الواو أو الياء الساكنة المفتوح ما قبلها، إذا وقع بعدها حرف يُسكَّن للوقف، مُدّت مدًّا لينًا سهلًا. ولا لين في نحو (يَوْمَ) وصلًا لأن ما بعدها متحرّك.',
    letters: 'وْ / يْ بعد فتحة',
    example: 'خَوْفٍ · قُرَيْشٍ · ٱلْبَيْتِ',
  },
  {
    id: 'madda_arid',
    category: 'madd',
    nameAr: 'المَدُّ العَارِضُ لِلسُّكُون',
    nameEn: 'Madd ʿĀriḍ lil-Sukūn',
    color: 'var(--tw-madda_arid)',
    durationAr: 'حركتان أو أربع أو ستّ (وقفًا)',
    description:
      'أن يأتي بعد حرف المدّ حرفٌ سكونه عارضٌ بسبب الوقف لا أصليّ. وللقارئ فيه ثلاثة أوجه: القصر حركتين، والتوسّط أربعًا، والإشباع ستًّا — ويلزم اطّراد وجهٍ واحد.',
    letters: 'حرف مدّ + آخر موقوف عليه',
    example: 'ٱلْعَالَمِينَ · نَسْتَعِينُ',
  },
  {
    id: 'madda_iwad',
    category: 'madd',
    nameAr: 'مَدُّ العِوَض',
    nameEn: 'Madd al-ʿIwaḍ',
    color: 'var(--tw-madda_iwad)',
    durationAr: 'حركتان (وقفًا)',
    description:
      'الوقف على تنوين الفتح، فيُبدَل التنوين ألفًا تُمدّ حركتين عوضًا عنه. ولا يدخل في ذلك تنوين الرفع والجرّ، ولا التاء المربوطة إذ يُوقف عليها هاءً ساكنة.',
    letters: 'تنوين فتح عند الوقف',
    example: 'عَلِيمًا ← عَلِيمَا · مَآءً ← مَآءَا',
  },
  {
    id: 'ra_mufakhkhama',
    category: 'other',
    nameAr: 'راء مُفخَّمة',
    nameEn: 'Rāʾ Mufakhkhamah',
    color: 'var(--tw-ra_mufakhkhama)',
    description:
      'تُفخَّم الراء فيُستعلى بها إلى أعلى الحنك: إذا كانت مفتوحة أو مضمومة، أو ساكنةً بعد فتح أو ضمّ، أو ساكنةً بعد كسرٍ عارض، أو بعدها حرف استعلاء غير مكسور.',
    example: 'رَبِّ · ٱلْقُرْءَان · وَٱنْحَرْ',
  },
  {
    id: 'ra_muraqqaqa',
    category: 'other',
    nameAr: 'راء مُرقَّقة',
    nameEn: 'Rāʾ Muraqqaqah',
    color: 'var(--tw-ra_muraqqaqa)',
    description:
      'تُرقَّق الراء فتنحف ويَنزل بها عن الحنك: إذا كانت مكسورة، أو ساكنةً بعد كسرٍ أصليّ وليس بعدها حرف استعلاء، أو ساكنةً بعد ياءٍ ساكنة قبلها كسر.',
    example: 'رِجَالٌ · فِرْعَوْن · خَيْرٌ',
  },
  {
    id: 'ra_wajhan',
    category: 'other',
    nameAr: 'راء يجوز فيها الوجهان',
    nameEn: 'Rāʾ — Both Permitted',
    color: 'var(--tw-ra_wajhan)',
    description:
      'مواضع اجتمع فيها موجِبُ التفخيم وموجِبُ الترقيق فجاز الوجهان، كالراء الساكنة بعد كسرٍ ويليها حرف استعلاء مكسور (فِرْقٍ)، أو الساكنة بعد ياء ساكنة عند بعض الأداء.',
    example: 'فِرْقٍ · مِصْرَ · ٱلْقِطْرِ',
  },
  {
    id: 'lam_jalalah_mufakhkhama',
    category: 'lam',
    nameAr: 'لام لفظ الجلالة مُفخَّمة',
    nameEn: 'Lām of Allāh — Heavy',
    color: 'var(--tw-lam_jalalah_mufakhkhama)',
    description: 'تُفخَّم لام لفظ الجلالة (ٱللَّه) إذا سبقها فتحٌ أو ضمّ، فتُنطق غليظة مستعلية.',
    example: 'قَالَ ٱللَّهُ · عَبْدُ ٱللَّهِ',
  },
  {
    id: 'lam_jalalah_muraqqaqa',
    category: 'lam',
    nameAr: 'لام لفظ الجلالة مُرقَّقة',
    nameEn: 'Lām of Allāh — Light',
    color: 'var(--tw-lam_jalalah_muraqqaqa)',
    description: 'تُرقَّق لام لفظ الجلالة إذا سبقها كسرٌ، سواء كان الكسر أصليًّا أم عارضًا.',
    example: 'بِسْمِ ٱللَّهِ · لِلَّهِ',
  },
  {
    id: 'istila',
    category: 'other',
    nameAr: 'حروف الاستعلاء (تفخيم)',
    nameEn: 'Istiʿlāʾ (Heavy Letters)',
    color: 'var(--tw-istila)',
    description:
      'سبعة أحرف يستعلي بها اللسان إلى الحنك الأعلى فتُنطق مفخَّمة دائمًا، مجموعةٌ في قولهم (خُصَّ ضَغْطٍ قِظْ)، وأقواها تفخيمًا المفتوح الذي بعده ألف.',
    letters: 'خ ص ض غ ط ق ظ',
    example: 'ٱلصَّلَاة · طَه · قَالَ',
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
  return withDerivedRules(words)
}

/**
 * Adds the rules the edition leaves unmarked (see uthmaniRules.ts) to each word, keeping
 * the marked ones first since they are authoritative for the letters they cover.
 *
 * An ayah's last word is treated as stopped on, which is what makes the madds of līn, ʿāriḍ
 * and ʿiwaḍ apply there — they exist only at a pause, and an ayah end is one. A derived rule
 * is dropped when the edition already marks something for that word, so a marked ikhfāʾ is
 * never shadowed by a derived iẓhār drawn from the same letters.
 */
function withDerivedRules(words: WordWithRules[]): WordWithRules[] {
  return words.map((w, i) => {
    const derived = deriveUthmaniRules(w.word, words[i + 1]?.word ?? '', words[i - 1]?.word ?? '', i === words.length - 1)
    const existing = new Set(w.rules)
    return { word: w.word, rules: [...w.rules, ...derived.filter((r) => !existing.has(r))] }
  })
}

/**
 * Rules that are true of a great many words and so say little about any one of them. The
 * heavy letters in particular appear in a large share of the Qur'an, and the heaviness of a
 * rāʾ or the lām of the divine name is a property of nearly every word containing them — if
 * these decided a word's colour, almost the whole passage would take their hue and the madd
 * or ghunnah actually worth noticing would be buried. They stay available in the word's rule
 * list and in the legend; they just do not win the colour.
 */
const LOW_SALIENCE_RULES = new Set<TajweedRuleId>([
  'ham_wasl',
  'laam_shamsiyah',
  'slnt',
  'istila',
  'izhar_halqi',
  'izhar_shafawi',
  'ra_mufakhkhama',
  'ra_muraqqaqa',
  'ra_wajhan',
  'lam_jalalah_mufakhkhama',
  'lam_jalalah_muraqqaqa',
])

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
