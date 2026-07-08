import type { ReactNode } from "react"

import { Card } from "./Card"
import { cx } from "./cx"

// A dashboard stat tile: an uppercase label, a large value with an optional
// `/ outOf` denominator, and an optional `hint` line (e.g. a shortcut link).
// Wraps Card so the tiles share one surface recipe and stop hand-composing the
// `text-2xl font-bold` + `text-base-content/70` body at each call site.

export type StatCardProps = {
  label: string
  value: ReactNode
  outOf?: ReactNode
  hint?: ReactNode
  className?: string
}

export function StatCard({
  label,
  value,
  outOf,
  hint,
  className,
}: StatCardProps) {
  return (
    <Card radius="xl" shadow={false} className={className}>
      <Card.Body className="gap-1 p-4">
        <span className="text-xs uppercase tracking-wide text-base-content/70">
          {label}
        </span>
        <div className={cx("flex items-baseline gap-1")}>
          <span className="text-2xl font-bold">{value}</span>
          {outOf != null && (
            <span className="text-base-content/70">/ {outOf}</span>
          )}
        </div>
        {hint}
      </Card.Body>
    </Card>
  )
}

export default StatCard
