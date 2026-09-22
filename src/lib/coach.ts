import { normalizeArabic } from './arabicText'
import { TAJWEED_RULE_MAP, type WordWithRules } from './tajweed'
import type { AcousticAlert } from './acousticTajweed'
import type { QalqalahAlert } from './qalqalah'
import type { TajweedRuleId } from '../types/quran'

/**
 * Turns each detected problem into one actionable sentence.
 *
 * Naming the rule that was broken is not teaching — a reciter who already knew how to fix
 * "مدّ واجب متصل" would not have broken it. Every tip therefore ends in something to *do*
 * differently on the next attempt, and each one names the word it belongs to so it can be
 * found in the passage.
 */

export type CoachSeverity = 'high' | 'medium'

export interface CoachTip {
  key: string
  word: string
  title: string
  action: string
  severity: CoachSeverity
}

const MADD_RULES = new Set<TajweedRuleId>(['madda_normal', 'madda_permissible', 'madda_obligatory', 'madda_necessary'])
const GHUNNA_RULES = new Set<TajweedRuleId>(['ghunnah', 'ikhafa', 'ikhafa_shafawi', 'idgham_ghunnah', 'iqlab'])

/** Tashkeel is helpful in the passage itself but noisy inside a one-line instruction. */
function plain(word: string): string {
  return normalizeArabic(word) || word
}

function ruleNames(rules: TajweedRuleId[], within: Set<TajweedRuleId>): string | null {
  const found = rules.filter((r) => within.has(r)).map((r) => TAJWEED_RULE_MAP[r]?.nameAr)
  return found.length > 0 ? found.join('، ') : null
}

export function buildCoachTips({
  referenceWords,
  wrongRefIndices,
  acousticAlerts,
  qalqalahAlerts,
}: {
  referenceWords: WordWithRules[]
  wrongRefIndices: number[]
  acousticAlerts: AcousticAlert[]
  qalqalahAlerts: QalqalahAlert[]
}): CoachTip[] {
  const tips: CoachTip[] = []

  for (const alert of acousticAlerts) {
    const word = plain(alert.word)
    const ruleName = TAJWEED_RULE_MAP[alert.rule]?.nameAr ?? (alert.kind === 'ghunnah' ? 'الغُنّة' : 'المدّ')
    const key = `${alert.kind}-${alert.refIndex}`
    const severe = alert.severity === 'severe'

    if (alert.kind === 'ghunnah') {
      tips.push({
        key,
        word,
        title: severe ? 'الغُنّة لم تظهر' : 'قصّرت الغُنّة',
        action: severe
          ? `«${word}» فيها ${ruleName}، ومرّت بلا غُنّة. أخرِج الصوت من الخيشوم وأمسكه مقدار حركتين قبل أن تنتقل إلى ما بعده.`
          : `الغُنّة في «${word}» جاءت أقصر من حركتين. أبقِ صوت الخيشوم واضحًا حتى تكتمل الحركتان.`,
        severity: severe ? 'high' : 'medium',
      })
      continue
    }

    tips.push({
      key,
      word,
      title: severe ? 'المدّ لم يُمدّ' : 'قصّرت المدّ',
      action: severe
        ? `«${word}» فيها ${ruleName}، ونُطقت كأنها بلا مدّ. أطِل حرف المدّ بمقدار حركاته كاملة ولا تقطعه بالنَّفَس.`
        : `${ruleName} في «${word}» جاء أقصر من المطلوب. عُدّ حركاته في نفسك أثناء النطق حتى يستوي مقداره.`,
      severity: severe ? 'high' : 'medium',
    })
  }

  for (const alert of qalqalahAlerts) {
    const word = plain(alert.word)
    tips.push({
      key: `qalqalah-${alert.refIndex}`,
      word,
      title: 'القلقلة غير واضحة',
      action: `القلقلة في «${word}» لم تظهر. اضغط على الحرف الساكن ثم أطلِقه دفعةً واحدة حتى تُسمع نبرة ارتداد، دون أن تُحرِّكه بفتحة أو كسرة.`,
      severity: 'medium',
    })
  }

  for (const refIndex of wrongRefIndices) {
    const refWord = referenceWords[refIndex]
    if (!refWord) continue
    const word = plain(refWord.word)
    const maddNames = ruleNames(refWord.rules, MADD_RULES)
    const ghunnaNames = ruleNames(refWord.rules, GHUNNA_RULES)

    let action = `لم تتطابق «${word}» مع النص. أعد قراءتها متمهّلًا وتأكّد من إخراج كل حرف من مخرجه.`
    if (maddNames) {
      action = `لم تتطابق «${word}» مع النص، وفيها ${maddNames}. أعد قراءتها متمهّلًا مع إشباع حرف المدّ — فقد يكون ابتلاعه هو ما غيّر صورة الكلمة.`
    } else if (ghunnaNames) {
      action = `لم تتطابق «${word}» مع النص، وفيها ${ghunnaNames}. أعد قراءتها مع إظهار الغنّة من الخيشوم مقدار حركتين.`
    }

    tips.push({ key: `word-${refIndex}`, word, title: 'كلمة لم تُطابق', action, severity: 'high' })
  }

  // Worst first, so the most damaging habit is the one the reciter reads first.
  return tips.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1))
}
