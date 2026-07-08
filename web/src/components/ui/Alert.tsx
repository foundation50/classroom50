import type { ComponentPropsWithoutRef, ReactNode } from "react"

import { cx } from "./cx"

// The canonical inline alert. Wraps daisyUI `alert` with the house `alert-soft`
// style (the tone->class map mirrors the toast provider) so the soft-vs-non-soft
// split converges. `soft` defaults on; pass `soft={false}` for a solid fill.
// `role` defaults to "alert" (assertive); pass `role="status"` for passive
// updates.

export type AlertTone = "info" | "success" | "warning" | "error"

const TONE_CLASS: Record<AlertTone, string> = {
  info: "alert-info",
  success: "alert-success",
  warning: "alert-warning",
  error: "alert-error",
}

export type AlertProps = {
  tone: AlertTone
  soft?: boolean
  children?: ReactNode
} & ComponentPropsWithoutRef<"div">

export function Alert({
  tone,
  soft = true,
  role = "alert",
  className,
  children,
  ...props
}: AlertProps) {
  return (
    <div
      role={role}
      className={cx("alert", TONE_CLASS[tone], soft && "alert-soft", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export default Alert
