import type { ReactNode } from "react"

import { cx } from "./cx"

// A control glued to a prefix in a daisyUI `join`, e.g. "Status: [select]" or
// an icon "[⛊][select]". The single source for the toolbar prefix recipe shared
// across dashboards so the prefix isn't hand-synced per site. Children are the
// control(s) — pass a `Select` (or any `join-item`) as the child.
//
// Prefer `icon` over `label`: the human-readable category lives in the child's
// `aria-label`, so the icon prefix stays purely visual (`aria-hidden`) and the
// bar stays compact. Fall back to `label` only where an icon would be ambiguous.
export type LabeledControlProps = {
  label?: ReactNode
  // Compact leading-icon prefix; when set it replaces the text `label`.
  icon?: ReactNode
  // Warning-toned (yellow) highlight on the prefix, signalling the control holds
  // a non-default value — a caller sets this when its filter/select is "active"
  // so a narrowed view is visible at a glance. Pair it with the same highlight on
  // the child control (Toolbar.FilterSelect does this via its own `active` prop).
  active?: boolean
  className?: string
  children: ReactNode
}

export function LabeledControl({
  label,
  icon,
  active = false,
  className,
  children,
}: LabeledControlProps) {
  const prefix = icon ?? label
  return (
    <div className={cx("join", className)}>
      <span
        className={cx(
          "join-item flex items-center whitespace-nowrap border text-sm",
          active
            ? "border-warning bg-warning/20 text-warning"
            : "border-base-300 bg-base-200 text-base-content/70",
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
