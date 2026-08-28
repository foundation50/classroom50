import type { ComponentProps } from "react"

import { cx } from "./cx"

// The canonical checkbox chrome. Wraps daisyUI `checkbox` so the inline
// recipes share one mapping; `sm` is the house size. Positional extras
// (`mt-0.5`, `size-6`) ride `className`. Label association stays the
// caller's concern — this is the input only.
export type CheckboxTone = "neutral" | "primary" | "error"
export type CheckboxSize = "sm" | "md"

const TONE_CLASS: Record<CheckboxTone, string> = {
  neutral: "",
  primary: "checkbox-primary",
  error: "checkbox-error",
}

const SIZE_CLASS: Record<CheckboxSize, string> = {
  sm: "checkbox-sm",
  md: "",
}

export type CheckboxProps = {
  tone?: CheckboxTone
  size?: CheckboxSize
} & Omit<ComponentProps<"input">, "type" | "size">

export function Checkbox({
  tone = "neutral",
  size = "sm",
  className,
  ...props
}: CheckboxProps) {
  return (
    <input
      type="checkbox"
      className={cx("checkbox", SIZE_CLASS[size], TONE_CLASS[tone], className)}
      {...props}
    />
  )
}

export default Checkbox
