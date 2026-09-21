/**
 * Orthographic variants of the reference text, for forced decoding.
 *
 * Forced decoding asks the model for the probability of *these exact tokens*, so the text
 * it is fed has to be spelled the way the model itself would spell it. That is a different
 * requirement from text comparison, which wants everything flattened so near-misses match.
 * Feeding the comparison form (tashkeel stripped, أ→ا, ة→ه) into forced decoding was what
 * made every word score ~0.1% even when recited perfectly: the model wanted to emit
 * «إِنَّا أَنْزَلْنَاهُ فِي لَيْلَةِ الْقَدْرِ» and was being asked to justify «انا انزلناه في ليله القدر»,
 * so every token mismatched.
 *
 * Which spelling a given Whisper checkpoint prefers is not something we can know up front —
 * it depends on how its fine-tuning transcripts were written. So rather than guess, the
 * worker scores more than one variant and keeps whichever the model finds most probable.
 */

export type OrthographyVariant = 'imlaei' | 'uthmani' | 'undiacritized'

/** Marks that exist only in the Uthmani script and have no counterpart in ordinary Arabic
 * typing, so a model trained on ordinary transcripts would never emit them. */
const UTHMANI_ONLY_MARKS = /[ؕ-ؚۖ-ۭ࢘-ࣣ࣡-ࣿ]/g
const TASHKEEL = /[ً-ْٰ]/g

/**
 * Uthmani spelling rewritten the way the text is ordinarily typed, keeping the vowel marks:
 * dagger alef becomes a real alef, the Uthmani vertical sukūn becomes an ordinary one, and
 * the recitation marks that only ever appear in a muṣḥaf are dropped.
 * «أَنزَلْنَٰهُ» → «أَنْزَلْنَاهُ», which is exactly what the model was observed to produce.
 */
export function toImlaei(word: string): string {
  return word
    .replace(/ٱ/g, 'ا') // alef wasla ٱ → ا
    .replace(/ٓ/g, '') // combining maddah: إِنَّآ → إِنَّا
    .replace(/ىٰ/g, 'ى') // alef maqsura already carries the length: عَلَىٰ → عَلَى
    .replace(/ٰ/g, 'ا') // any other dagger alef ٰ → ا: أَنزَلْنَٰهُ → أَنزَلْنَاهُ
    // A final maqsura preceded by kasra is a consonantal yāʾ that the Uthmani script writes
    // dotless (فِى → فِي); preceded by fatha it is a true alef maqsura and must stay (هُدَى).
    .replace(/ِى$/g, 'ِي')
    .replace(/ۡ/g, 'ْ') // Uthmani vertical sukun ۡ → ْ
    .replace(/ࣰ/g, 'ً') // Uthmani tanween fath → ً
    .replace(/ࣱ/g, 'ٌ') // Uthmani tanween damm → ٌ
    .replace(/ࣲ/g, 'ٍ') // Uthmani tanween kasr → ٍ
    .replace(UTHMANI_ONLY_MARKS, '')
    .replace(/ـ/g, '') // tatweel
    .replace(/\s+/g, ' ')
    .trim()
}

/** The same ordinary spelling with the vowel marks removed, but hamza seats and tāʾ marbūṭa
 * left intact — for a checkpoint whose transcripts were written without tashkeel. */
export function toUndiacritized(word: string): string {
  return toImlaei(word).replace(TASHKEEL, '').trim()
}

/** The spellings worth trying, in the order most likely to match first. */
export const ORTHOGRAPHY_VARIANTS: OrthographyVariant[] = ['imlaei', 'uthmani', 'undiacritized']

export function applyVariant(word: string, variant: OrthographyVariant): string {
  switch (variant) {
    case 'imlaei':
      return toImlaei(word)
    case 'uthmani':
      return word
    case 'undiacritized':
      return toUndiacritized(word)
  }
}
