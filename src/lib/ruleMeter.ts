import type { TajweedRuleId } from '../types/quran'
import type { WordWithRules } from './tajweed'
import { GHUNNA_RULES } from './wordTiming'
import { maddHarakatAt, maddOptionalExtraAt, paceOf, type PaceId } from './recitationPace'
import type { Hold } from './holdDetector'

/**
 * One bar per ruling, in the ruling's own colour, filling as that ruling is performed.
 *
 * A single bar for the whole word could only say "you held something for long enough in
 * total". «يَتَسَآءَلُونَ» carries a wājib muttaṣil on its alif and an ʿāriḍ on its wāw; a
 * reciter who gives the first eight ḥarakāt and the second none has satisfied the word's
 * total and broken one of its two rulings, and the old meter would have shown a full bar.
 *
 * So each held ruling gets its own bar, ordered as its letters are ordered in the word, and
 * each fills only from the hold that belongs to it.
 */

const GHUNNA_HARAKAT = 2

export type RuleMeterState = 'pending' | 'active' | 'complete' | 'short'

export interface RuleMeter {
  rule: TajweedRuleId
  kind: 'madd' | 'ghunnah'
  /** Where in the word this ruling's letters sit — the bars are ordered by it. */
  start: number
  end: number
  /** How long this ruling has actually been held, in ms. */
  heldMs: number
  /** What it owes at the selected pace. */
  requiredMs: number
  /** What it may be stretched to beyond that, if anything. */
  optionalMs: number
  state: RuleMeterState
}

/** The held rulings of a word, in the order their letters appear. */
export function heldRulesOf(word: WordWithRules, paceId?: PaceId): Omit<RuleMeter, 'heldMs' | 'state'>[] {
  const pace = paceOf(paceId)
  const seen = new Set<TajweedRuleId>()
  const out: Omit<RuleMeter, 'heldMs' | 'state'>[] = []

  for (const span of [...(word.spans ?? [])].sort((a, b) => a.start - b.start)) {
    // A rule can be marked on more than one run of letters (the heavy letters especially).
    // Only the first is a bar; a ruling is one obligation however it is written.
    if (seen.has(span.rule)) continue
    const maddHarakat = maddHarakatAt(pace, span.rule)
    const isGhunnah = GHUNNA_RULES.has(span.rule)
    if (maddHarakat === 0 && !isGhunnah) continue
    seen.add(span.rule)
    out.push({
      rule: span.rule,
      kind: maddHarakat > 0 ? 'madd' : 'ghunnah',
      start: span.start,
      end: span.end,
      requiredMs: (maddHarakat > 0 ? maddHarakat : GHUNNA_HARAKAT) * pace.harakaMs,
      optionalMs: maddOptionalExtraAt(pace, span.rule) * pace.harakaMs,
    })
  }
  return out
}

/**
 * Holds too brief to be a performed ruling. A real madd is at minimum two ḥarakāt of held
 * sound; anything much under that is a steady moment inside an ordinary syllable, and
 * crediting it to a ruling would fill a bar the reciter never earned.
 */
const MIN_CREDIBLE_HOLD_MS = 120

/**
 * How much of a hold may be lost to measurement before it still counts as complete.
 *
 * A hold's edges are found by watching the spectrum settle and then move again, sampled in
 * frames, so a frame or so is trimmed at each end — a madd held for exactly its due measures
 * a little under it. Without this, «الٓمٓ» held for the full six ḥarakāt came back ten
 * milliseconds short and was reported as a fault. The same allowance the post-hoc duration
 * check makes for the same reason (see TIMING_TOLERANCE_MS in acousticTajweed.ts).
 */
const HOLD_EDGE_TOLERANCE_MS = 60

/**
 * Matches the holds heard in a word to the rulings the muṣḥaf gives it.
 *
 * Not simply first-to-first. A word's ordinary syllables can hold still for a moment too, so
 * the holds found are a superset of the rulings performed — «عَمَّ» recited with its ghunnah
 * yields three holds for one ruling, the murmur between two brief steady vowels. Matching
 * blindly in order would credit the ghunnah to the first of those and report it as clipped.
 *
 * Two things make the match reliable without identifying a single letter. Order: the
 * rulings' letters have a fixed order in the text, so a hold can never satisfy a ruling
 * earlier than one already matched. And kind: only a *nasal* hold can perform a ghunnah, and
 * only an oral one a madd, which the detector reports per hold. A ruling takes the first
 * hold after its predecessor that is credible in length and right in kind.
 */
export function matchHoldsToRules(
  rules: Omit<RuleMeter, 'heldMs' | 'state'>[],
  holds: Hold[],
  /** The hold still in progress, if any — so the bar moves while the sound is being held. */
  openHold: { startMs: number; elapsedMs: number; nasal: boolean | null } | null,
  /**
   * Whether the word is over.
   *
   * It decides what an unmatched ruling means, and the two meanings are opposite. Mid-word,
   * a ruling with no hold yet has simply not been reached — the reciter is still on the
   * letters before it, and colouring its bar red would accuse them of something they are
   * about to do. Once the word has ended, the same state means it was passed over.
   */
  finished = false,
): RuleMeter[] {
  const candidates: { startMs: number; durationMs: number; nasal: boolean | null; open: boolean }[] = holds.map(
    (h) => ({ startMs: h.startMs, durationMs: h.endMs - h.startMs, nasal: h.nasal, open: false }),
  )
  if (openHold) {
    candidates.push({
      startMs: openHold.startMs,
      durationMs: Math.max(0, openHold.elapsedMs - openHold.startMs),
      nasal: openHold.nasal,
      open: true,
    })
  }

  let cursor = 0
  return rules.map((rule, ruleIndex) => {
    // The ruling is performed by the *longest* compatible hold available to it, not merely
    // the first. «الٓمٓ» is recited «أَلِفْ… لَامْ… مِيمْ», and the brief steady vowel of «أَلِفْ»
    // is a credible hold that comes before the madd — taken as the ruling it reported a
    // properly held madd lāzim as short. An ordinary steady moment is always shorter than a
    // sound deliberately held for six ḥarakāt, so length is what separates them.
    //
    // Order is still kept: a ruling may not take a hold before one already matched, and it
    // must leave a hold for each ruling that follows it.
    // Leave a hold for each ruling that follows — but never at the cost of this one. With
    // fewer holds heard than the word has rulings, reserving starved the earlier ruling and
    // handed its madd to the later one, so «يَتَسَآءَلُونَ» reported the muttaṣil unperformed
    // and the ʿāriḍ complete when the reciter had done exactly the reverse. Order decides
    // first: an earlier ruling always has the first claim.
    const rulesAfter = rules.length - 1 - ruleIndex
    const limit = Math.min(candidates.length, Math.max(cursor + 1, candidates.length - rulesAfter))
    let matched: (typeof candidates)[number] | null = null
    let matchedAt = -1
    for (let i = cursor; i < limit; i++) {
      const c = candidates[i]
      if (c.durationMs < MIN_CREDIBLE_HOLD_MS && !c.open) continue
      // A nasal hold cannot be a madd and an oral one cannot be a ghunnah. Where the
      // detector could not tell (no oral sound in the word to compare against), it reports
      // null and the hold is allowed to serve either.
      if (c.nasal !== null) {
        if (rule.kind === 'ghunnah' && !c.nasal) continue
        if (rule.kind === 'madd' && c.nasal) continue
      }
      // A hold still in progress wins outright: the reciter is performing this ruling now,
      // and the bar must follow the sound rather than some longer one already past.
      if (c.open) {
        matched = c
        matchedAt = i
        break
      }
      if (!matched || c.durationMs > matched.durationMs) {
        matched = c
        matchedAt = i
      }
    }
    if (matchedAt >= 0) cursor = matchedAt + 1

    const heldMs = matched?.durationMs ?? 0
    let state: RuleMeterState
    if (matched) {
      state = matched.open ? 'active' : heldMs >= rule.requiredMs - HOLD_EDGE_TOLERANCE_MS ? 'complete' : 'short'
    } else if (finished) {
      // The word is over and this ruling never sounded: it was passed over.
      state = 'short'
    } else if (cursor < candidates.length) {
      // A later hold has already been credited to a later ruling, so the reciter has moved
      // past this one even though the word is still being said.
      state = 'short'
    } else {
      state = 'pending'
    }
    return { ...rule, heldMs, state }
  })
}

/** Rulings the reciter passed over or cut short — what the reciter is told about. */
export function unmetRules(meters: RuleMeter[]): RuleMeter[] {
  return meters.filter((m) => m.state === 'short')
}
