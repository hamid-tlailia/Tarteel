/** Strips tashkeel (harakat), tatweel and normalizes letter variants for lenient comparison. */
export function normalizeArabic(input: string): string {
  return input
    .replace(/[ً-ْٰۖ-ۭ]/g, '') // harakat, sukoon, superscript alef, small marks
    .replace(/ـ/g, '') // tatweel
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^ء-ي\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function toWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

export function normalizedWords(text: string): string[] {
  return toWords(normalizeArabic(text))
}
