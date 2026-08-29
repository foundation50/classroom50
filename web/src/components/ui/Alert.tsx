import type { ComponentPropsWithoutRef, ReactNode } from "react"
import { useTranslation } from "react-i18next"

import {
  AlertIcon,
  CheckCircleIcon,
  CircleSlashIcon,
  InfoIcon,
  StopIcon,
  XIcon,
} from "@/components/ui/icons"

import { Button } from "./Button"
import { cx } from "./cx"

// The canonical inline alert, following Primer's Banner anatomy
// (primer.style/product/ui-patterns/notification-messaging): a designated
// tone icon (opt out with `icon={null}`, replace with `icon={...}`), an
// optional semibold `title`, and an optional dismiss button via `onDismiss`.
// The tone->class recipe is exported as `alertToneClass` so the toast
// provider (which needs a motion wrapper, not <Alert>) shares one source and
// can't drift. `soft` defaults on; pass `soft={false}` for a solid fill.
// `role` defaults by tone — "alert" (assertive) only for errors, "status"
// (polite) otherwise — matching the app-wide messaging ARIA convention.

export type AlertTone = "info" | "success" | "warning" | "error" | "unavailable"

const TONE_CLASS: Record<AlertTone, string> = {
  info: "alert-info",
  success: "alert-success",
  warning: "alert-warning",
  error: "alert-error",
  // Primer's `unavailable` state (degraded reads, permission gates): the
  // bare neutral alert — deliberately not a color, so a page of degraded
  // sections reads calm rather than alarming.
  unavailable: "",
}

// The single source of truth for the alert tone->class recipe. Reused by the
// toast provider (which can't render <Alert> directly — it needs a motion.div
// wrapper) so the two surfaces can't drift.
export function alertToneClass(tone: AlertTone, soft = true): string {
  return cx("alert", TONE_CLASS[tone], soft && "alert-soft")
}

// Primer Banner's designated state icons (critical -> stop octagon). Shared
// with the toast provider for the same one-source reason as alertToneClass.
export const ALERT_TONE_ICON: Record<AlertTone, typeof InfoIcon> = {
  info: InfoIcon,
  success: CheckCircleIcon,
  warning: AlertIcon,
  error: StopIcon,
  unavailable: CircleSlashIcon,
}

export function alertToneRole(tone: AlertTone): "alert" | "status" {
  return tone === "error" ? "alert" : "status"
}

// One shared shape for "the outcome of the last action", rendered via
// <OutcomeAlert>. Sites narrow the tone union in their own state types but
// share this contract instead of re-declaring it inline.
export type AlertOutcome = {
  tone: AlertTone
  message: string
}

export type AlertProps = {
  tone: AlertTone
  soft?: boolean
  // Default: the designated tone icon. Pass null to omit, or a ReactNode to
  // replace (contextual icons like a cloud for offline warnings).
  icon?: ReactNode | null
  title?: ReactNode
  onDismiss?: () => void
  children?: ReactNode
} & ComponentPropsWithoutRef<"div">

export function Alert({
  tone,
  soft = true,
  icon,
  title,
  onDismiss,
  role,
  className,
  children,
  ...props
}: AlertProps) {
  const { t } = useTranslation()
  const ToneIcon = ALERT_TONE_ICON[tone]
  const resolvedIcon =
    icon === null
      ? null
      : (icon ?? <ToneIcon aria-hidden="true" className="size-4 shrink-0" />)
  return (
    <div
      role={role ?? alertToneRole(tone)}
      className={cx(alertToneClass(tone, soft), className)}
      {...props}
    >
      {resolvedIcon}
      {title != null ? (
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          {children}
        </div>
      ) : (
        children
      )}
      {onDismiss && (
        <Button
          variant="ghost"
          size="xs"
          shape="circle"
          className="ms-auto shrink-0"
          aria-label={t("components.banner.dismiss")}
          onClick={onDismiss}
        >
          <XIcon aria-hidden="true" className="size-4" />
        </Button>
      )}
    </div>
  )
}

export default Alert
