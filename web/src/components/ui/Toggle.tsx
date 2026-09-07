import type { ComponentProps } from "react"

import { cx } from "./cx"

// The canonical switch chrome (a checkbox wearing daisyUI `toggle`).
// `primary` is the house tone (ToggleField's settings recipe); `neutral`
// and `warning` cover the divergent inline sites. Label layout stays the
// caller's concern — ToggleField owns the standard settings-row recipe.
export type ToggleTone = "neutral" | "primary" | "warning"
export type ToggleSize = "sm" | "md"

const TONE_CLASS: Record<ToggleTone, string> = {
  neutral: "",
  primary: "toggle-primary",
  warning: "toggle-warning",
}

const SIZE_CLASS: Record<ToggleSize, string> = {
  sm: "toggle-sm",
  md: "",
}

export type ToggleProps = {
  tone?: ToggleTone
  size?: ToggleSize
} & Omit<ComponentProps<"input">, "type" | "size">

export function Toggle({
  tone = "primary",
  size = "md",
  className,
  ...props
}: ToggleProps) {
  return (
    <input
      type="checkbox"
      className={cx("toggle", SIZE_CLASS[size], TONE_CLASS[tone], className)}
      {...props}
    />
  )
}

export default Toggle
