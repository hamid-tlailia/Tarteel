import type { WordWithRules } from './tajweed'
import type { PaceId } from './recitationPace'
import { HoldTracker } from './holdDetector'
import { heldRulesOf, matchHoldsToRules, type RuleMeter } from './ruleMeter'

/**
 * Live bars for every ruling in the passage, without pretending to know which word is being
 * recited.
 *
 * The bars used to hang off a cursor that guessed the current word from microphone loudness, and
 * the guess was wrong by 0.6–1.2 seconds — more than a word — so they were removed. Following the
 * reference recitation instead was tried and measured (see liveAlign.ts): promising in half the
 * cases and several words out in the rest, which is not something to put on a screen.
 *
 * But the bars never needed a cursor. A hold detector hears a sustained sound the moment it
 * happens, and the rulings of a passage have a fixed order in the text. Matching the holds heard
 * so far against the rulings in that order — the same matching the results card does inside one
 * word, applied to the whole passage — puts each bar under its own ruling as it is performed,
 * with no claim about position at all. It asks one thing of the reciter, which the text asks of
 * them anyway: recite in order.
 *
 * Where it is wrong it is wrong quietly. Skip a ruling and its bar stays empty while the next
 * one fills, which is the truth; hold something that is not a ruling and it is matched to
 * nothing, because a hold may only satisfy a ruling of its own kind — nasal for a ghunnah, oral
 * for a madd.
 */

export interface LivePassageSnapshot {
  /** One entry per word that has any held ruling, keyed by its index in the passage. */
  metersByWord: Map<number, RuleMeter[]>
  /** How many of the passage's rulings have been satisfied so far. */
  completed: number
  /** How many there are in total, so progress can be shown without naming a word. */
  total: number
  /** Whether any audio has reached the detector at all. */
  heardAudio: boolean
}

export class LivePassageRules {
  private tracker = new HoldTracker()
  /** Every held ruling in the passage, flattened in reading order, with its word. */
  private rules: (ReturnType<typeof heldRulesOf>[number] & { wordIndex: number })[] = []
  private heardAudio = false

  constructor(words: WordWithRules[], paceId?: PaceId) {
    words.forEach((word, wordIndex) => {
      for (const rule of heldRulesOf(word, paceId)) this.rules.push({ ...rule, wordIndex })
    })
  }

  /** Feeds one frame of microphone audio, exactly as the hold meter is fed live. */
  feed(samples: Float32Array, sampleRate: number, dtMs: number): void {
    this.heardAudio = true
    this.tracker.feed(samples, sampleRate, dtMs)
  }

  snapshot(): LivePassageSnapshot {
    const { holds, openStartMs, elapsedMs } = this.tracker.current()
    const meters = matchHoldsToRules(
      this.rules,
      holds,
      openStartMs === null ? null : { startMs: openStartMs, elapsedMs, nasal: null },
      false,
    )
    const metersByWord = new Map<number, RuleMeter[]>()
    meters.forEach((meter, i) => {
      const wordIndex = this.rules[i].wordIndex
      const list = metersByWord.get(wordIndex)
      if (list) list.push(meter)
      else metersByWord.set(wordIndex, [meter])
    })
    return {
      metersByWord,
      completed: meters.filter((m) => m.state === 'complete').length,
      total: meters.length,
      heardAudio: this.heardAudio,
    }
  }
}
