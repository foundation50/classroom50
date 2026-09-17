import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react"

import {
  intersectRects,
  placeTooltip,
  type Rect,
  type TooltipPosition,
} from "@/util/tooltipPlacement"
import { cx } from "./cx"

export type { TooltipPosition } from "@/util/tooltipPlacement"

export type TooltipTone = "neutral" | "warning"

// The one hover/focus tooltip. The bubble is a popover, so it renders in the
// browser's top layer: no `overflow` ancestor can clip it and no z-indexed
// sibling (the sidebar rail, a modal) can paint over it. Positioning is done in
// viewport coordinates on each open, flipping or sliding the bubble to stay
// inside its bounds (see placeTooltip). Issue #1026 was the previous CSS-only
// tooltip being centered on its trigger and cut off by whatever lay to its left.
//
// Bounds default to the viewport. An ancestor can spread `tooltipArenaProps` to
// narrow them, so a bubble stays inside e.g. the page column instead of
// straddling the sidebar rail; that is a legibility choice, not a clipping
// constraint.
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

const ARENA_ATTR = "data-tooltip-arena"

// Spread onto the element whose box descendant tooltips should stay inside.
export const tooltipArenaProps = { [ARENA_ATTR]: "" } as const

function viewportRect(): Rect {
  return {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  }
}

function arenaRect(host: HTMLElement): Rect | undefined {
  const arena = host.closest(`[${ARENA_ATTR}]`)
  return arena
    ? intersectRects(viewportRect(), arena.getBoundingClientRect())
    : undefined
}

const toneClass: Record<TooltipTone, string> = {
  neutral: "",
  warning:
    "[--tooltip-bg:var(--color-warning)] [--tooltip-fg:var(--color-warning-content)]",
}

// Popover support arrived in every evergreen engine in 2024; without it the
// bubble still shows (position: fixed) but can be clipped like before.
const supportsPopover =
  typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype

function showBubble(bubble: HTMLElement) {
  if (supportsPopover) {
    if (!bubble.matches(":popover-open")) bubble.showPopover()
  } else {
    bubble.hidden = false
  }
}

function hideBubble(bubble: HTMLElement) {
  if (supportsPopover) {
    if (bubble.matches(":popover-open")) bubble.hidePopover()
  } else {
    bubble.hidden = true
  }
}

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
  onKeyDown,
  ...props
}: TooltipProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const host = hostRef.current
    const bubble = bubbleRef.current
    if (!host || !bubble) return
    if (!open) {
      hideBubble(bubble)
      return
    }
    // Show first: a hidden popover has no box to measure.
    showBubble(bubble)
    const size = bubble.getBoundingClientRect()
    const placed = placeTooltip({
      trigger: host.getBoundingClientRect(),
      bubble: { width: size.width, height: size.height },
      viewport: viewportRect(),
      arena: arenaRect(host),
      preferred: position,
    })
    bubble.dataset.side = placed.position
    bubble.style.left = `${placed.left}px`
    bubble.style.top = `${placed.top}px`
    bubble.style.setProperty("--tooltip-tail", `${placed.tail}px`)

    const close = () => setOpen(false)
    // A tap opens the bubble but fires pointerleave as soon as the finger
    // lifts, so touch closes on the next tap elsewhere instead.
    const closeIfOutside = (event: PointerEvent) => {
      if (!host.contains(event.target as Node)) close()
    }
    window.addEventListener("scroll", close, { capture: true, passive: true })
    window.addEventListener("resize", close)
    document.addEventListener("pointerdown", closeIfOutside, true)
    return () => {
      window.removeEventListener("scroll", close, { capture: true })
      window.removeEventListener("resize", close)
      document.removeEventListener("pointerdown", closeIfOutside, true)
      hideBubble(bubble)
    }
  }, [open, position, tip])

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
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          // Only the tooltip goes away; the dialog or menu behind it stays.
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }
        onKeyDown?.(event)
      }}
      {...props}
    >
      {children}
      <div
        ref={bubbleRef}
        aria-hidden="true"
        popover="manual"
        hidden={!supportsPopover}
        className={cx("tooltip-bubble", bubbleClassName)}
      >
        {tip}
      </div>
    </Tag>
  )
}

export default Tooltip
