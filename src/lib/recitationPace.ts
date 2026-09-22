import type { TajweedRuleId } from '../types/quran'

/**
 * The three classical paces of recitation, and what each one changes.
 *
 * Until now the app measured every reciter against one tempo. That is wrong twice over. It
 * penalised anyone reciting faster or slower than the single set of constants baked into
 * wordTiming.ts — and, more importantly, it ignored that the pace a reciter chooses actually
 * *changes the rulings*, not merely the clock. The ʿāriḍ lil-sukūn is two ḥarakāt in ḥadr,
 * four in tadwīr and six in taḥqīq; all three are sound, and which one is owed depends on
 * the pace being read in. A single tempo had to pick one and call the others faults.
 *
 * So a pace here carries two things: how long a ḥaraka lasts in absolute time, and how many
 * ḥarakāt each madd is given. The lāzim stays at six in every pace — it has no shorter
 * reading — and the natural madd stays at two.
 */
export type PaceId = 'hadr' | 'tadweer' | 'tahqiq'

export interface PaceProfile {
  id: PaceId
  nameAr: string
  /** One line a learner can choose by. */
  taglineAr: string
  descriptionAr: string
  /**
   * How long one ḥaraka lasts, in milliseconds.
   *
   * Reasoned from the usual teaching that two ḥarakāt is about half a second at a measured
   * pace, not fitted to recordings — there is no corpus here to fit to. They are what the
   * *selected* pace expects; what the reciter actually did is measured separately and
   * reported back (see detectPace), so a mismatch shows up as information rather than as a
   * fault.
   */
  harakaMs: number
  /** Ḥarakāt each madd is given at this pace. Rules absent here are the same in every pace. */
  maddHarakat: Partial<Record<TajweedRuleId, number>>
}

/** Lengths that do not change with pace: the lāzim has no shorter reading, and the natural
 * madd no longer one. */
const FIXED_MADD_HARAKAT: Partial<Record<TajweedRuleId, number>> = {
  madda_normal: 2,
  madda_necessary: 6,
  madda_badal: 2,
  madda_sila_sughra: 2,
  madda_iwad: 2,
}

export const PACES: PaceProfile[] = [
  {
    id: 'hadr',
    nameAr: 'الحَدْر',
    taglineAr: 'سريع — للمراجعة والحفظ',
    descriptionAr:
      'الإسراع في القراءة مع إقامة الأحكام كاملة. تُقصَر فيه المدود إلى أدنى ما تُجيزه، فالمدّ العارض حركتان. يُستعمل عادةً في مراجعة المحفوظ.',
    harakaMs: 185,
    maddHarakat: {
      madda_obligatory: 4,
      madda_permissible: 4,
      madda_sila_kubra: 4,
      madda_arid: 2,
      madda_leen: 2,
    },
  },
  {
    id: 'tadweer',
    nameAr: 'التَّدْوِير',
    taglineAr: 'متوسط — الأكثر شيوعًا',
    descriptionAr:
      'مرتبة وسط بين الحدر والتحقيق، وهي التي يقرأ بها أكثر القرّاء. المدّ العارض فيها أربع حركات، والواجب أربع.',
    harakaMs: 260,
    maddHarakat: {
      madda_obligatory: 4,
      madda_permissible: 4,
      madda_sila_kubra: 4,
      madda_arid: 4,
      madda_leen: 4,
    },
  },
  {
    id: 'tahqiq',
    nameAr: 'التَّحْقِيق',
    taglineAr: 'بطيء — للتعلّم والتدريب',
    descriptionAr:
      'التأنّي وإعطاء كل حرف حقّه ومستحقّه، وهي مرتبة التعليم. تُشبَع فيها المدود، فالعارض ستّ حركات والواجب خمس.',
    harakaMs: 355,
    maddHarakat: {
      madda_obligatory: 5,
      madda_permissible: 5,
      madda_sila_kubra: 5,
      madda_arid: 6,
      madda_leen: 6,
    },
  },
]

export const DEFAULT_PACE_ID: PaceId = 'tadweer'

const BY_ID = new Map(PACES.map((p) => [p.id, p]))

export function paceOf(id: PaceId | undefined | null): PaceProfile {
  return BY_ID.get(id ?? DEFAULT_PACE_ID) ?? BY_ID.get(DEFAULT_PACE_ID)!
}

/** How many ḥarakāt this rule is owed at this pace, or 0 if it is not a madd. */
export function maddHarakatAt(pace: PaceProfile, rule: TajweedRuleId): number {
  return pace.maddHarakat[rule] ?? FIXED_MADD_HARAKAT[rule] ?? 0
}

/**
 * Whether a madd at this pace may be stretched further, and by how many ḥarakāt.
 *
 * Only where the reciter genuinely has a choice. The ʿāriḍ and the līn permit two, four or
 * six whatever the pace, so what is *owed* is the pace's own reading and anything up to six
 * remains on offer — which is what the meter shows past its finish line. At taḥqīq, where
 * six is already owed, nothing is left over.
 */
export function maddOptionalExtraAt(pace: PaceProfile, rule: TajweedRuleId): number {
  if (rule !== 'madda_arid' && rule !== 'madda_leen') return 0
  return Math.max(0, 6 - maddHarakatAt(pace, rule))
}

/**
 * Which pace the reciter was actually reading in, from the ḥaraka length their recitation
 * implies. Returns the nearest profile — never null, since some pace was always being read.
 */
export function detectPace(measuredHarakaMs: number): PaceProfile {
  let best = PACES[0]
  let bestDistance = Infinity
  for (const pace of PACES) {
    // Compared on a log scale: being 40ms off matters far more at ḥadr's 185ms than at
    // taḥqīq's 355ms, and a plain difference would quietly favour the slower paces.
    const distance = Math.abs(Math.log(measuredHarakaMs / pace.harakaMs))
    if (distance < bestDistance) {
      bestDistance = distance
      best = pace
    }
  }
  return best
}

/** How far off the chosen pace a recitation was, as a ratio (1 = exactly on it). */
export function paceRatio(pace: PaceProfile, measuredHarakaMs: number): number {
  return measuredHarakaMs / pace.harakaMs
}
