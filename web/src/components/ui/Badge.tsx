import type { ComponentPropsWithoutRef, ReactNode } from "react"

import { cx } from "./cx"

// The canonical status chip. Wraps daisyUI `badge` so the ~45 inline sites
// share one mapping. `soft` (default true) is the house style for semantic
// status; `ghost` covers neutral count/tag chips. Semantic tones inherit the
// per-theme `.badge-soft` contrast nudge from index.css.

export type BadgeTone =
  "neutral" | "primary" | "secondary" | "info" | "success" | "warning" | "error"

export type BadgeSize = "xs" | "sm" | "md"

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "",
  primary: "badge-primary",
  secondary: "badge-secondary",
  info: "badge-info",
  success: "badge-success",
  warning: "badge-warning",
  error: "badge-error",
}

const SIZE_CLASS: Record<BadgeSize, string> = {
  xs: "badge-xs",
  sm: "badge-sm",
  md: "",
}

export type BadgeProps = {
  tone?: BadgeTone
  size?: BadgeSize
  soft?: boolean
  ghost?: boolean
  children?: ReactNode
} & ComponentPropsWithoutRef<"span">

export function Badge({
  tone = "neutral",
  size = "sm",
  soft = true,
  ghost = false,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cx(
        "badge",
        SIZE_CLASS[size],
        ghost ? "badge-ghost" : TONE_CLASS[tone],
        !ghost && soft && tone !== "neutral" && "badge-soft",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}

export default Badge
