import type { CSSProperties } from "react"

import { Badge } from "./Badge"

// One funnel metric (e.g. accepted / submitted): the absolute count as a
// soft-toned badge (bold tabular numerals, fixed slot so columns align), then
// a compact radial dial with the percentage inside. The denominator lives in
// the tooltip wording — the dial already expresses "out of how many" as a
// fraction of the circle. A faint 100% track sits under the value ring so a
// low percentage still reads as a dial rather than a floating number. Callers
// keep value <= max so the dial can never contradict its count. One `tone`
// drives badge and ring together: info = accepted, success = submitted.
const RING_CLASS = {
  info: "text-info",
  success: "text-success",
} as const

export type MetricDialTone = keyof typeof RING_CLASS

const ringStyle = (value: number) =>
  ({
    "--value": value,
    "--size": "2rem",
    "--thickness": "3px",
  }) as CSSProperties

export type MetricDialProps = {
  value: number
  max: number
  tone: MetricDialTone
  title: string
}

export function MetricDial({ value, max, tone, title }: MetricDialProps) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100)
  return (
    <div className="flex items-center gap-2 whitespace-nowrap" title={title}>
      <Badge
        tone={tone}
        className="min-w-8 justify-center font-bold tabular-nums"
      >
        {value}
      </Badge>
      <div
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="relative"
      >
        {/* base-300 (not a muted base-content/NN text tier) — the track is a
            decorative ring, so it must not register with the text-contrast
            coverage guard. */}
        <div
          className="radial-progress text-base-300"
          style={ringStyle(100)}
          aria-hidden="true"
        />
        <div
          className={`radial-progress absolute inset-0 ${RING_CLASS[tone]}`}
          style={ringStyle(pct)}
          aria-hidden="true"
        />
        <span className="absolute inset-0 flex items-center justify-center text-[0.625rem] font-semibold tabular-nums text-base-content">
          {pct}%
        </span>
      </div>
    </div>
  )
}

export default MetricDial
