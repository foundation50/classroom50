import type { ComponentProps } from "react"

import { cx } from "./cx"

// The canonical radio chrome. Wraps daisyUI `radio`; unlike Checkbox the
// house size is the default (`md` = bare `radio`). Positional extras
// (`mt-1`) ride `className`; label association stays the caller's concern.
export type RadioTone = "neutral" | "primary"
export type RadioSize = "sm" | "md"

const TONE_CLASS: Record<RadioTone, string> = {
  neutral: "",
  primary: "radio-primary",
}

const SIZE_CLASS: Record<RadioSize, string> = {
  sm: "radio-sm",
  md: "",
}

export type RadioProps = {
  tone?: RadioTone
  size?: RadioSize
} & Omit<ComponentProps<"input">, "type" | "size">

export function Radio({
  tone = "neutral",
  size = "md",
  className,
  ...props
}: RadioProps) {
  return (
    <input
      type="radio"
      className={cx("radio", SIZE_CLASS[size], TONE_CLASS[tone], className)}
      {...props}
    />
  )
}

export default Radio
