import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react"

import { useDismissOnEscape } from "@/hooks/useDismissOnEscape"
import { useDismissOnOutsidePointerDown } from "@/hooks/useDismissOnOutsidePointerDown"
import { useAnchoredPopover, type OverlaySide } from "./anchoredPopover"
import { cx } from "./cx"

export type TooltipPosition = OverlaySide
export type TooltipTone = "neutral" | "warning"

// The one hover/focus tooltip. The bubble is a top-layer popover positioned
// against its trigger by useAnchoredPopover, flipping or sliding to stay inside
// its bounds. Issue #1026 was the previous CSS-only tooltip being centered on
// its trigger and cut off by whatever lay to its left.
//
// The bubble is decorative for assistive tech (aria-hidden): the trigger must
// carry its own accessible name, e.g. HelpTooltip's `aria-label`. Escape
// dismisses without moving focus (WCAG 1.4.13), and a scroll while open closes
// it rather than leaving a stale bubble behind.
//
// A lint rule keeps raw daisyUI `tooltip` / `data-tip` markup out of the rest
// of the codebase so no site can opt out of this.
export type TooltipProps = {
  tip: string
  // The preferred side; the bubble flips to the opposite side when the
  // preferred one lacks room.
  position?: TooltipPosition
  tone?: TooltipTone
  as?: "span" | "div"
  // Extra classes for the bubble itself (e.g. `whitespace-pre-line`).
  bubbleClassName?: string
  children: ReactNode
} & Omit<ComponentPropsWithoutRef<"div">, "children">

const toneClass: Record<TooltipTone, string> = {
  neutral: "",
  warning:
    "[--tooltip-bg:var(--color-warning)] [--tooltip-fg:var(--color-warning-content)]",
}

// 4px tail plus 4px of air between the trigger and the bubble.
const TOOLTIP_GAP = 8

export function Tooltip({
  tip,
  position = "top",
  tone = "neutral",
  as: Tag = "span",
  bubbleClassName,
  className,
  children,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  ...props
}: TooltipProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  useAnchoredPopover({
    open,
    anchorRef: hostRef,
    panelRef: bubbleRef,
    side: position,
    gap: TOOLTIP_GAP,
    followScroll: false,
    contentKey: tip,
  })

  // Only the tooltip goes away on Escape; the dialog or menu behind it stays.
  useDismissOnEscape(hostRef, open, close)
  // A tap opens the bubble but fires pointerleave as soon as the finger lifts,
  // so touch closes on the next tap elsewhere instead.
  useDismissOnOutsidePointerDown(hostRef, open, close)

  // A scroll while open closes the bubble rather than leaving a stale one.
  useEffect(() => {
    if (!open) return
    window.addEventListener("scroll", close, { capture: true, passive: true })
    return () => window.removeEventListener("scroll", close, { capture: true })
  }, [open, close])

  return (
    <Tag
      ref={hostRef}
      className={cx("inline-block", toneClass[tone], className)}
      onPointerEnter={(event) => {
        setOpen(true)
        onPointerEnter?.(event)
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") setOpen(false)
        onPointerLeave?.(event)
      }}
      onFocus={(event) => {
        setOpen(true)
        onFocus?.(event)
      }}
      onBlur={(event) => {
        setOpen(false)
        onBlur?.(event)
      }}
      {...props}
    >
      {children}
      <div
        ref={bubbleRef}
        aria-hidden="true"
        popover="manual"
        className={cx("overlay-panel tooltip-bubble", bubbleClassName)}
      >
        {tip}
      </div>
    </Tag>
  )
}

export default Tooltip
