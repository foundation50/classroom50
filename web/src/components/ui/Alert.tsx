import type { ComponentPropsWithoutRef, ReactNode } from "react"

import { cx } from "./cx"

// The canonical inline alert. Wraps daisyUI `alert` with the house `alert-soft`
// style; the tone->class recipe is exported as `alertToneClass` so the toast
// provider (which needs a motion wrapper, not <Alert>) shares one source and
// can't drift. `soft` defaults on; pass `soft={false}` for a solid fill.
// `role` defaults to "alert" (assertive); pass `role="status"` for passive
// updates.

export type AlertTone = "info" | "success" | "warning" | "error"

const TONE_CLASS: Record<AlertTone, string> = {
  info: "alert-info",
  success: "alert-success",
  warning: "alert-warning",
  error: "alert-error",
}

// The single source of truth for the alert tone->class recipe. Reused by the
// toast provider (which can't render <Alert> directly — it needs a motion.div
// wrapper) so the two surfaces can't drift.
export function alertToneClass(tone: AlertTone, soft = true): string {
  return cx("alert", TONE_CLASS[tone], soft && "alert-soft")
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
      className={cx(alertToneClass(tone, soft), className)}
      {...props}
    >
      {children}
    </div>
  )
}

export default Alert
