import clsx from 'clsx'
import { TAJWEED_RULE_MAP } from '../lib/tajweed'
import type { RuleMeter } from '../lib/ruleMeter'

/**
 * One bar per ruling under a word, each in that ruling's own colour.
 *
 * A single bar for the whole word could only say that *something* was held for long enough
 * in total. «يَتَسَآءَلُونَ» carries a wājib muttaṣil on its alif and an ʿāriḍ on its wāw: a
 * reciter who gives the first eight ḥarakāt and the second none satisfies the word's total
 * while breaking one of its two rulings, and a single bar would have shown it full.
 *
 * The bars are stacked in the order the rulings' letters run, so the top one is the ruling
 * reached first. Each carries the colour the same ruling is painted in the text above, which
 * is what ties the bar to the letters it is about without a word of explanation.
 */
export function RuleBars({
  meters,
  fillRefs,
}: {
  meters: RuleMeter[]
  /** Hands each bar's filled element back, so the animation-frame loop can set its width
   * directly rather than through a re-render of the whole passage. */
  fillRefs?: (index: number, el: HTMLSpanElement | null) => void
}) {
  if (meters.length === 0) return null

  return (
    <span aria-hidden className="absolute inset-x-1 bottom-0 flex flex-col gap-[2px]">
      {meters.map((meter, index) => {
        const colour = TAJWEED_RULE_MAP[meter.rule]?.color ?? 'var(--c-gold)'
        const span = meter.requiredMs + meter.optionalMs
        const requiredShare = span > 0 ? (meter.requiredMs / span) * 100 : 100
        const filled = span > 0 ? Math.min(100, (meter.heldMs / span) * 100) : 0

        return (
          <span
            key={`${meter.rule}-${meter.start}`}
            className={clsx(
              'relative block h-1.5 overflow-hidden rounded-full',
              // A ruling not yet reached is drawn faintly: the reciter is still on the
              // letters before it and has done nothing wrong yet.
              meter.state === 'pending' ? 'bg-line-soft/50' : 'bg-line-soft',
            )}
          >
            {/* What the ruling merely permits beyond its due, shown past the finish line so
                it never reads as owed. */}
            {meter.optionalMs > 0 && (
              <span
                className="absolute inset-y-0 right-0 opacity-20"
                style={{ width: `${100 - requiredShare}%`, background: colour }}
              />
            )}
            <span
              ref={fillRefs ? (el) => fillRefs(index, el) : undefined}
              className="absolute inset-y-0 right-0 rounded-full"
              style={{
                width: `${filled}%`,
                background: colour,
                // Short of what it owed, and the reciter has moved on: the bar keeps the
                // ruling's colour — it is still that ruling — but says so by dimming.
                opacity: meter.state === 'short' ? 0.45 : 1,
              }}
            />
            {/* The finish line: where the obligation ends and choice begins. */}
            {meter.optionalMs > 0 && (
              <span
                className="absolute inset-y-0 w-px bg-ink/40"
                style={{ right: `${requiredShare}%` }}
              />
            )}
            {/* A ruling the reciter seems to have left short, marked in the cautionary colour
                rather than the error one. Live, this is a clock's opinion: the tracker follows
                loudness, not letters, and can be a word behind. The definite word comes from
                the analysis after the recording — see the note above the live view. */}
            {meter.state === 'short' && (
              <span className="absolute inset-y-0 left-0 w-0.5 rounded-full bg-warn" />
            )}
          </span>
        )
      })}
    </span>
  )
}

/** The height the bars occupy, so the word above can reserve room for them. */
export function ruleBarsHeightClass(count: number): string {
  if (count <= 0) return 'pb-1'
  if (count === 1) return 'pb-2.5'
  if (count === 2) return 'pb-4'
  return 'pb-5'
}
