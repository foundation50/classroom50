import type { ComponentPropsWithoutRef, ReactNode } from "react"
import {
  AlertIcon,
  InfoIcon,
  NoEntryIcon,
  XCircleIcon,
} from "@primer/octicons-react"

import { cx } from "./cx"

// Primer-style inline message: a small icon + one short line of feedback tied
// to a specific item (vs <Alert>, a standalone banner). Tones use the
// text-safe semantic tokens — the themes darken/lighten these for readable
// body text on base surfaces — NOT the `*-content` on-fill tokens, which are
// only readable on their own solid fill (on a card they can render invisible).

export type InlineMessageTone = "info" | "warning" | "error" | "neutral"

const TONE_TEXT_CLASS: Record<InlineMessageTone, string> = {
  info: "text-info",
  warning: "text-warning",
  error: "text-error",
  neutral: "text-base-content/70",
}

const TONE_ICON: Record<InlineMessageTone, typeof InfoIcon> = {
  info: InfoIcon,
  warning: AlertIcon,
  error: XCircleIcon,
  neutral: NoEntryIcon,
}

export type InlineMessageProps = {
  tone?: InlineMessageTone
  children?: ReactNode
} & ComponentPropsWithoutRef<"p">

export function InlineMessage({
  tone = "neutral",
  className,
  children,
  ...props
}: InlineMessageProps) {
  const Icon = TONE_ICON[tone]
  return (
    <p
      className={cx(
        "flex items-start gap-1.5 text-sm",
        TONE_TEXT_CLASS[tone],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

export default InlineMessage
