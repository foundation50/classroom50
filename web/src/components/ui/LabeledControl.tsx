import type { ReactNode } from "react"

import { cx } from "./cx"

// A control glued to a `bg-base-200` label prefix in a daisyUI `join`, e.g.
// "Status: [select]". The single source for the toolbar label-prefix recipe
// shared across dashboards (submissions, classroom list) so the prefix span
// isn't hand-synced per site. Children are the control(s) — pass a `Select`
// (or any `join-item`) as the child.
export type LabeledControlProps = {
  label: ReactNode
  className?: string
  children: ReactNode
}

export function LabeledControl({
  label,
  className,
  children,
}: LabeledControlProps) {
  return (
    <div className={cx("join", className)}>
      <span className="join-item flex items-center whitespace-nowrap border border-base-300 bg-base-200 px-3 text-sm text-base-content/70">
        {label}
      </span>
      {children}
    </div>
  )
}

export default LabeledControl
