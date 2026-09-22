import type { TajweedRuleId } from '../types/quran'

/**
 * Derives the tajweed rules of Ḥafṣ ʿan ʿĀṣim that the source text does not mark.
 *
 * The alquran.cloud `quran-tajweed` edition only marks rules that *change* a sound —
 * assimilation, nasalisation, conversion, elongation. It marks nothing for the rules whose
 * correct performance is to leave a letter plain (the two kinds of iẓhār), nothing for the
 * madd types that only arise when stopping (ʿāriḍ, līn, ʿiwaḍ), nothing for badal or the
 * two ṣilah madds, and nothing for the heaviness or lightness of rāʾ and the lām of the
 * divine name. Those are worked out here, from the Uthmani script itself.
 *
 * Two things make that script the right source rather than an obstacle. Its own marks
 * settle cases that would otherwise need guessing: the small wāw and yāʾ over a pronoun's
 * hāʾ mark ṣilah outright, and the small mīm marks iqlāb. And its vowelling distinguishes
 * cases that look identical once stripped — most importantly a final nūn written bare (a
 * true sukūn, which carries the rules of nūn sākinah) from one written with a vowel because
 * it was moved to avoid two meeting sukūns, as in «مِنَ ٱللَّهِ», which carries no rule at all
 * and is simply pronounced plain.
 *
 * Rulings follow the standard primers — تحفة الأطفال للجمزوري and المقدمة الجزرية — for the
 * riwāyah of Ḥafṣ by the ṭarīq of al-Shāṭibiyyah.
 */

/* ── Marks and letters, as the Uthmani script writes them ────────────────────────────── */

const FATHA = 'َ'
const KASRA = 'ِ'
const DAMMA = 'ُ'
const SUKUN = 'ْ'
const SHADDA = 'ّ'
const TANWEEN_FATH = 'ً'
const TANWEEN_DAMM = 'ٌ'
const TANWEEN_KASR = 'ٍ'
const DAGGER_ALEF = 'ٰ'
const UTHMANI_SUKUN = 'ۡ' // small high dotless head of khāʾ, used as a sukūn
const UTHMANI_TANWEEN_FATH = 'ࣰ'
const UTHMANI_TANWEEN_DAMM = 'ࣱ'
const UTHMANI_TANWEEN_KASR = 'ࣲ'
const SMALL_MEEM_IQLAB = 'ۢ'
const SMALL_WAW_SILAH = 'ۥ'
const SMALL_YA_SILAH = 'ۦ'
const MADDAH = 'ٓ'
const HAMZA_ABOVE = 'ٔ'
const HAMZA_BELOW = 'ٕ'
const ALEF_WASLA = 'ٱ'
const TATWEEL = 'ـ'

const SHORT_VOWELS = new Set([FATHA, KASRA, DAMMA])
const TANWEEN = new Set([TANWEEN_FATH, TANWEEN_DAMM, TANWEEN_KASR])

/** ء ه ع ح غ خ — the six throat letters that make a nūn sākinah plain. */
const THROAT_LETTERS = new Set(['ء', 'أ', 'إ', 'ؤ', 'ئ', 'ه', 'ع', 'ح', 'غ', 'خ'])
/** خُصَّ ضَغْطٍ قِظْ — the seven letters pronounced heavy wherever they fall. */
const ISTILA_LETTERS = new Set(['خ', 'ص', 'ض', 'غ', 'ط', 'ق', 'ظ'])
const HAMZA_FORMS = new Set(['ء', 'أ', 'إ', 'ؤ', 'ئ'])

interface Letter {
  ch: string
  /** Where this letter and its marks sit in the original word string. */
  from: number
  to: number
  /** The single vowel on this letter: fatḥa, kasra, ḍamma, sukūn, a tanwīn, or '' if bare. */
  vowel: string
  shadda: boolean
  /** A superscript alef, which lengthens this letter like a written alef would. */
  daggerAlef: boolean
  /** The muṣḥaf's small wāw/yāʾ marking a pronoun hāʾ as joined (ṣilah). */
  silahMark: boolean
  /** The muṣḥaf's small mīm marking iqlāb. */
  iqlabMark: boolean
}

/**
 * Splits a word into its letters, each carrying the marks written above or below it.
 * The Uthmani-only marks are folded onto the letter they belong to so the rules below can
 * read a letter's state without re-examining the raw codepoints.
 */
export function tokenizeUthmani(word: string): Letter[] {
  const letters: Letter[] = []
  const last = () => letters[letters.length - 1]
  let offset = 0

  for (const ch of word) {
    const at = offset
    offset += ch.length
    if (ch === TATWEEL) continue

    const blank = { vowel: '', shadda: false, daggerAlef: false, silahMark: false, iqlabMark: false }
    // A base letter: anything in the Arabic letter block that is not a combining mark.
    if (ch >= 'ء' && ch <= 'ي') {
      letters.push({ ch, from: at, to: at + ch.length, ...blank })
      continue
    }
    if (ch === ALEF_WASLA) {
      letters.push({ ch: 'ا', from: at, to: at + ch.length, ...blank })
      continue
    }

    const target = last()
    if (!target) continue
    // A mark belongs to the letter it sits on, so that letter's span grows to cover it.
    target.to = at + ch.length

    if (ch === SHADDA) target.shadda = true
    else if (ch === DAGGER_ALEF) target.daggerAlef = true
    else if (ch === SMALL_WAW_SILAH || ch === SMALL_YA_SILAH) target.silahMark = true
    else if (ch === SMALL_MEEM_IQLAB) target.iqlabMark = true
    else if (ch === UTHMANI_SUKUN) {
      if (!target.vowel) target.vowel = SUKUN
    } else if (ch === UTHMANI_TANWEEN_FATH) {
      if (!target.vowel) target.vowel = TANWEEN_FATH
    } else if (ch === UTHMANI_TANWEEN_DAMM) {
      if (!target.vowel) target.vowel = TANWEEN_DAMM
    } else if (ch === UTHMANI_TANWEEN_KASR) {
      if (!target.vowel) target.vowel = TANWEEN_KASR
    } else if (ch === HAMZA_ABOVE || ch === HAMZA_BELOW) {
      // A hamza written on a seat: the seat itself is the hamza.
      if (!target.vowel && ['ا', 'و', 'ي', 'ى'].includes(target.ch)) target.ch = 'ء'
    } else if (ch === MADDAH) {
      // Purely a length sign over an alef; it carries no ruling of its own here.
      continue
    } else if (SHORT_VOWELS.has(ch) || TANWEEN.has(ch) || ch === SUKUN) {
      if (!target.vowel) target.vowel = ch
    }
    // Everything else (waqf signs, ayah marks, other annotations) carries no ruling.
  }

  return letters
}

/* ── Small predicates the rulings are phrased in terms of ────────────────────────────── */

/** A letter with no vowel written on it, or an explicit sukūn — i.e. genuinely sākin. */
const isSakin = (l: Letter | undefined): boolean => !!l && (l.vowel === '' || l.vowel === SUKUN)
const isTanween = (l: Letter | undefined): boolean => !!l && TANWEEN.has(l.vowel)
const isHamza = (l: Letter | undefined): boolean => !!l && HAMZA_FORMS.has(l.ch)

/** Whether this position is a letter of prolongation: a bare alef/wāw/yāʾ whose preceding
 * vowel matches it, or any letter carrying a superscript alef. */
function isMaddLetter(letters: Letter[], i: number): boolean {
  const l = letters[i]
  if (!l) return false
  if (l.daggerAlef) return true
  if (!isSakin(l) || l.shadda) return false
  const prev = letters[i - 1]
  if (!prev) return false
  if ((l.ch === 'ا' || l.ch === 'ى') && prev.vowel === FATHA) return true
  if (l.ch === 'و' && prev.vowel === DAMMA) return true
  if (l.ch === 'ي' && prev.vowel === KASRA) return true
  return false
}

/** The first letter of the following word, which the previous word's ending is ruled by. */
function firstLetterOf(word: string): Letter | undefined {
  return tokenizeUthmani(word)[0]
}

/** The last vowel actually pronounced before a position, looking back past sākin letters. */
function precedingVowel(letters: Letter[], i: number): string | null {
  for (let k = i - 1; k >= 0; k--) {
    const l = letters[k]
    if (SHORT_VOWELS.has(l.vowel)) return l.vowel
    if (TANWEEN.has(l.vowel)) return l.vowel === TANWEEN_KASR ? KASRA : l.vowel === TANWEEN_DAMM ? DAMMA : FATHA
  }
  return null
}

/** A derived rule together with the letters it lands on, so the text can be coloured at
 * those letters exactly as the edition's own markup colours the ones it marks. */
interface RuleHit {
  rule: TajweedRuleId
  letters: number[]
}

/** A derived rule and the character range of the word it covers. */
export interface DerivedRuleSpan {
  rule: TajweedRuleId
  start: number
  end: number
}

/* ── The rulings ─────────────────────────────────────────────────────────────────────── */

/**
 * Iẓhār ḥalqī: a nūn sākinah or tanwīn followed by one of the six throat letters is left
 * plain. The edition marks the other three rulings of nūn sākinah (idghām, iqlāb, ikhfāʾ)
 * but not this one, because leaving a sound alone needs no markup.
 *
 * A nūn carrying a vowel is deliberately excluded. In «مِنَ ٱللَّهِ» the nūn is written with a
 * fatḥa because it was moved to avoid two sukūns meeting once the joining hamza dropped; it
 * is a moving letter, outside the rulings of nūn sākinah entirely, and the script says so.
 */
function izharHalqi(letters: Letter[], nextWord: string): RuleHit | null {
  const next = nextWord ? firstLetterOf(nextWord) : undefined
  const followsInside = (i: number) => letters[i + 1]

  for (let i = 0; i < letters.length; i++) {
    const l = letters[i]
    const isFinal = i === letters.length - 1
    const following = isFinal ? next : followsInside(i)
    if (!following) continue

    const ruledByNun = l.ch === 'ن' && isSakin(l) && !l.shadda
    const ruledByTanween = isTanween(l) && isFinal
    if (!ruledByNun && !ruledByTanween) continue
    // Iqlāb is marked in the script itself and is a different ruling.
    if (l.iqlabMark) continue

    if (THROAT_LETTERS.has(following.ch)) return { rule: 'izhar_halqi', letters: [i] }
  }
  return null
}

/**
 * Iẓhār shafawī: a mīm sākinah followed by anything other than bāʾ or mīm is pronounced
 * plainly from the lips. The other two cases (ikhfāʾ shafawī before bāʾ, idghām before
 * mīm) are marked by the edition; this one is not.
 */
function izharShafawi(letters: Letter[], nextWord: string): RuleHit | null {
  const next = nextWord ? firstLetterOf(nextWord) : undefined

  for (let i = 0; i < letters.length; i++) {
    const l = letters[i]
    if (l.ch !== 'م' || !isSakin(l) || l.shadda) continue
    const isFinal = i === letters.length - 1
    const following = isFinal ? next : letters[i + 1]
    if (!following) continue
    if (following.ch === 'ب' || following.ch === 'م') continue
    return { rule: 'izhar_shafawi', letters: [i] }
  }
  return null
}

/** Madd al-badal: a hamza followed, in the same word, by a letter of prolongation. */
function maddBadal(letters: Letter[]): RuleHit | null {
  for (let i = 1; i < letters.length; i++) {
    if (!isMaddLetter(letters, i)) continue
    if (isHamza(letters[i - 1])) return { rule: 'madda_badal', letters: [i] }
    // A superscript alef sits on the hamza itself rather than after it (ءَٰ).
    if (letters[i].daggerAlef && isHamza(letters[i])) return { rule: 'madda_badal', letters: [i] }
  }
  return null
}

/**
 * The two ṣilah madds. The muṣḥaf marks a joined pronoun hāʾ with a small wāw or yāʾ, so
 * this is read from the script rather than inferred: greater ṣilah when a cutting hamza
 * begins the next word, lesser otherwise.
 */
function maddSilah(letters: Letter[], nextWord: string): RuleHit | null {
  const at = letters.findIndex((l) => l.ch === 'ه' && l.silahMark)
  if (at < 0) return null
  const next = nextWord ? firstLetterOf(nextWord) : undefined
  const rule: TajweedRuleId = next && isHamza(next) ? 'madda_sila_kubra' : 'madda_sila_sughra'
  return { rule, letters: [at] }
}

/**
 * Madd al-līn: a sākin wāw or yāʾ preceded by a fatḥa, with one further letter after it
 * that falls silent at a stop. It only exists when stopping — joined to what follows, the
 * letter after it is voiced and there is no madd. «يَوْمَ» is the standard counter-example:
 * the letter before the wāw is a fatḥa on a yāʾ, which the primers exclude.
 */
function maddLeen(letters: Letter[], stopsHere: boolean): RuleHit | null {
  if (!stopsHere || letters.length < 3) return null
  const last = letters[letters.length - 1]
  const leen = letters[letters.length - 2]
  const before = letters[letters.length - 3]
  if (!leen || !before || !last) return null
  if (leen.ch !== 'و' && leen.ch !== 'ي') return null
  if (!isSakin(leen) || leen.shadda) return null
  if (before.vowel !== FATHA) return null
  if (before.ch === 'و' || before.ch === 'ي') return null
  if (!SHORT_VOWELS.has(last.vowel) && !isTanween(last)) return null
  return { rule: 'madda_leen', letters: [letters.length - 2] }
}

/**
 * Madd ʿāriḍ lil-sukūn: a letter of prolongation whose following letter only falls silent
 * because the reciter stopped there. Joined onward, that letter is voiced and the madd is
 * merely natural.
 */
function maddArid(letters: Letter[], stopsHere: boolean): RuleHit | null {
  if (!stopsHere || letters.length < 2) return null
  const last = letters[letters.length - 1]
  if (!SHORT_VOWELS.has(last.vowel) && !isTanween(last)) return null
  if (isTanween(last) && last.vowel === TANWEEN_FATH) return null // that is ʿiwaḍ, below
  return isMaddLetter(letters, letters.length - 2) ? { rule: 'madda_arid', letters: [letters.length - 2] } : null
}

/**
 * Madd al-ʿiwaḍ: stopping on a tanwīn fatḥ, which becomes an alef of two ḥarakāt standing
 * in for it. Stopping on a tāʾ marbūṭah is excluded — it becomes a silent hāʾ, not a madd.
 */
function maddIwad(letters: Letter[], stopsHere: boolean): RuleHit | null {
  if (!stopsHere) return null
  for (let i = letters.length - 1; i >= Math.max(0, letters.length - 2); i--) {
    if (letters[i].vowel !== TANWEEN_FATH) continue
    if (letters[i].ch === 'ة') return null
    return { rule: 'madda_iwad', letters: [i] }
  }
  return null
}

/**
 * The rāʾ, heavy or light. Where the causes of heaviness and lightness meet, Ḥafṣ permits
 * both, and saying so is more honest than forcing a single answer.
 */
function raRule(letters: Letter[], stopsHere: boolean): RuleHit | null {
  for (let i = 0; i < letters.length; i++) {
    const r = letters[i]
    if (r.ch !== 'ر') continue
    const prev = letters[i - 1]
    const next = letters[i + 1]

    // Stopping drops a final letter's vowel, which can flip the ruling: «خَيْرٌ» joined has a
    // moving, heavy rāʾ, but stopped on it becomes sākinah after a sākin yāʾ, and light.
    const stopped = stopsHere && i === letters.length - 1
    if (!stopped) {
      if (SHORT_VOWELS.has(r.vowel)) return { rule: r.vowel === KASRA ? 'ra_muraqqaqa' : 'ra_mufakhkhama', letters: [i] }
      if (isTanween(r)) return { rule: r.vowel === TANWEEN_KASR ? 'ra_muraqqaqa' : 'ra_mufakhkhama', letters: [i] }
    }

    if ((stopped || isSakin(r)) && prev) {
      // After a sākin yāʾ, the yāʾ itself lightens it.
      if (prev.ch === 'ي' && isSakin(prev)) return { rule: 'ra_muraqqaqa', letters: [i] }
      const kasraBefore = prev.vowel === KASRA || (isSakin(prev) && letters[i - 2]?.vowel === KASRA)
      if (kasraBefore) {
        // A heavy letter after it, itself carrying a kasra, pulls both ways (فِرْقٍ).
        if (next && ISTILA_LETTERS.has(next.ch) && (next.vowel === KASRA || next.vowel === TANWEEN_KASR)) {
          return { rule: 'ra_wajhan', letters: [i] }
        }
        // A heavy letter standing between the kasra and the rāʾ likewise (مِصْرَ).
        if (ISTILA_LETTERS.has(prev.ch) && isSakin(prev)) return { rule: 'ra_wajhan', letters: [i] }
        // A kasra that only appeared to carry a joining hamza does not lighten it.
        if (prev.ch === 'ا' && prev.vowel === KASRA) return { rule: 'ra_mufakhkhama', letters: [i] }
        return { rule: 'ra_muraqqaqa', letters: [i] }
      }
      return { rule: 'ra_mufakhkhama', letters: [i] }
    }
  }
  return null
}

/** Letters that may be attached in front of the divine name. */
const ALLAH_PREFIXES = new Set(['و', 'ف', 'ب', 'ك', 'ت', 'ل'])

/** Where the divine name begins in this word, or -1. Matches ٱللَّه and the attached forms. */
function allahStart(letters: Letter[]): number {
  const at = (i: number) => letters[i]?.ch
  for (let i = 0; i <= 1 && i < letters.length; i++) {
    if (i === 1 && !ALLAH_PREFIXES.has(letters[0].ch)) break
    if (at(i) === 'ا' && at(i + 1) === 'ل' && at(i + 2) === 'ل' && at(i + 3) === 'ه') return i
    // لِلَّهِ: the lām of the preposition merges with the definite article's lām.
    if (at(i) === 'ل' && at(i + 1) === 'ل' && letters[i + 1]?.shadda && at(i + 2) === 'ه') return i
  }
  return -1
}

/**
 * The lām of the divine name: heavy after a fatḥa or ḍamma, light after a kasra. The vowel
 * that decides it may sit on a letter attached in front of the name, or end the word before.
 */
function lamJalalah(letters: Letter[], prevWord: string): RuleHit | null {
  const start = allahStart(letters)
  if (start < 0) return null

  let deciding: string | null = null
  if (start > 0 && SHORT_VOWELS.has(letters[0].vowel)) deciding = letters[0].vowel
  else if (letters[start]?.ch === 'ل' && SHORT_VOWELS.has(letters[start].vowel)) deciding = letters[start].vowel
  else if (prevWord) {
    const prevLetters = tokenizeUthmani(prevWord)
    deciding = precedingVowel(prevLetters, prevLetters.length)
  }

  // Colour the doubled lam of the name itself rather than the whole word.
  const lamAt = letters.findIndex((l, i) => i >= start && l.ch === 'ل' && l.shadda)
  return {
    rule: deciding === KASRA ? 'lam_jalalah_muraqqaqa' : 'lam_jalalah_mufakhkhama',
    letters: [lamAt >= 0 ? lamAt : start],
  }
}

/** Any of the seven heavy letters present in the word. */
function istila(letters: Letter[]): RuleHit | null {
  const hits = letters.map((l, i) => (ISTILA_LETTERS.has(l.ch) ? i : -1)).filter((i) => i >= 0)
  return hits.length > 0 ? { rule: 'istila', letters: hits } : null
}

/**
 * Every rule of this word that the source markup leaves unmarked.
 *
 * @param word      the word as the muṣḥaf writes it, marks intact
 * @param nextWord  the word joined to it, or '' when stopping after this one
 * @param prevWord  the word before it, for rulings decided by a preceding vowel
 * @param stopsHere whether the reciter stops on this word — the madds of līn, ʿāriḍ and
 *                  ʿiwaḍ exist only at a stop, and an ayah's end is a stop
 */
export function deriveUthmaniRules(word: string, nextWord = '', prevWord = '', stopsHere = false): TajweedRuleId[] {
  const seen = new Set<TajweedRuleId>()
  const rules: TajweedRuleId[] = []
  for (const hit of deriveRuleHits(word, nextWord, prevWord, stopsHere)) {
    if (!seen.has(hit.rule)) {
      seen.add(hit.rule)
      rules.push(hit.rule)
    }
  }
  return rules
}

/**
 * The same rules, each with the character range of the word it covers — so a derived rule
 * can colour its own letters, exactly as the edition's markup colours the ones it marks.
 */
export function deriveUthmaniRuleSpans(
  word: string,
  nextWord = '',
  prevWord = '',
  stopsHere = false,
): DerivedRuleSpan[] {
  const letters = tokenizeUthmani(word)
  const spans: DerivedRuleSpan[] = []
  for (const hit of deriveRuleHits(word, nextWord, prevWord, stopsHere)) {
    for (const index of hit.letters) {
      const letter = letters[index]
      if (letter) spans.push({ rule: hit.rule, start: letter.from, end: letter.to })
    }
  }
  return spans
}

function deriveRuleHits(word: string, nextWord: string, prevWord: string, stopsHere: boolean): RuleHit[] {
  const letters = tokenizeUthmani(word)
  if (letters.length === 0) return []

  const found = [
    izharHalqi(letters, nextWord),
    izharShafawi(letters, nextWord),
    maddBadal(letters),
    maddSilah(letters, nextWord),
    maddLeen(letters, stopsHere),
    maddArid(letters, stopsHere),
    maddIwad(letters, stopsHere),
    raRule(letters, stopsHere),
    lamJalalah(letters, prevWord),
    istila(letters),
  ]

  return found.filter((hit): hit is RuleHit => hit !== null)
}
