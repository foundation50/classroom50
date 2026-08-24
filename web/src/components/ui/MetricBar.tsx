import type { ReactNode } from "react"

import { Badge } from "./Badge"

// One funnel metric (e.g. accepted / submitted) as a compact progress bar
// with its numbers beneath: the exact ratio lower-left, the percentage
// lower-right. Callers keep value <= max so the bar can never contradict its
// numbers. One `tone` per metric kind: info = accepted, success = submitted.
const BAR_CLASS = {
  info: "progress-info",
  success: "progress-success",
} as const

export type MetricTone = keyof typeof BAR_CLASS

// The bare count companion — for funnel counts that have no denominator to
// measure against (e.g. group acceptance). Kept here so the recipe has one
// source and can't drift from the bar's.
export type MetricCountProps = {
  value: ReactNode
  tone: MetricTone
  title?: string
}

export function MetricCount({ value, tone, title }: MetricCountProps) {
  return (
    <Badge
      tone={tone}
      className="min-w-8 justify-center font-bold tabular-nums"
      title={title}
    >
      {value}
    </Badge>
  )
}

export type MetricBarProps = {
  value: number
  max: number
  tone: MetricTone
  title: string
  // Omit the ratio/percentage row under the bar — for tight spots (the
  // submissions header strip) where the tooltip carries the numbers.
  showNumbers?: boolean
}

export function MetricBar({
  value,
  max,
  tone,
  title,
  showNumbers = true,
}: MetricBarProps) {
  const pct = max === 0 ? 0 : Math.round((value / max) * 100)
  return (
    <div className="inline-flex w-28 flex-col gap-0.5" title={title}>
      {/* Native <progress> carries the progressbar semantics itself; the
          percentage scale keeps a 0-denominator honest (an empty bar). */}
      <progress
        className={`progress h-1.5 w-full ${BAR_CLASS[tone]}`}
        value={pct}
        max={100}
        aria-label={title}
      />
      {showNumbers && (
        <div className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
          <span>
            {value} / {max}
          </span>
          <span className="text-base-content/60">{pct}%</span>
        </div>
      )}
    </div>
  )
}

export default MetricBar
