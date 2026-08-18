import type { ReactNode } from "react"

import { cx } from "./cx"

// A control glued to a prefix in a daisyUI `join`, e.g. "Status: [select]" or
// an icon "[⛊][select]". The single source for the toolbar prefix recipe shared
// across dashboards (submissions, classroom list, assignments, activity) so the
// prefix isn't hand-synced per site. Children are the control(s) — pass a
// `Select` (or any `join-item`) as the child.
//
// Prefer `icon` over `label`: a leading icon (funnel for a filter, up/down for a
// sort) plus a self-describing option value ("All sections", "By first name")
// keeps the control compact and obvious without repeating the category word.
// The human-readable category still lives in the child's `aria-label`, so the
// icon prefix is purely visual and marked `aria-hidden` by the caller. Fall back
// to `label` (the text prefix) only where an icon would be ambiguous.
export type LabeledControlProps = {
  label?: ReactNode
  // Compact leading-icon prefix; when set it replaces the text `label`.
  icon?: ReactNode
  className?: string
  children: ReactNode
}

export function LabeledControl({
  label,
  icon,
  className,
  children,
}: LabeledControlProps) {
  const prefix = icon ?? label
  return (
    <div className={cx("join", className)}>
      <span
        className={cx(
          "join-item flex items-center whitespace-nowrap border border-base-300 bg-base-200 text-sm text-base-content/70",
          // An icon prefix is a tight square; a text prefix keeps the wider pad.
          icon ? "px-2" : "px-3",
        )}
      >
        {prefix}
      </span>
      {children}
    </div>
  )
}

export default LabeledControl
