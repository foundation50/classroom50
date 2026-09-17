// Placement math for the <Tooltip> bubble. Pure geometry so it is testable in
// node; the component measures the DOM and calls this on every open.
//
// The bubble is a top-layer popover positioned in viewport coordinates, so
// nothing can clip or cover it; the viewport is the hard limit and an optional
// `arena` (the page column beside the sidebar rail) is where it should stay for
// legibility. The caller's `preferred` side is kept unless it lacks room and the
// opposite side has more; along the trigger's edge the bubble is clamped inside
// the bounds and the tail slides to stay pointed at the trigger (issue #1026: a
// centered bubble beside a short field label ran under the sidebar rail).

export type TooltipPosition = "top" | "bottom" | "left" | "right"

export type Rect = { left: number; top: number; right: number; bottom: number }
export type Size = { width: number; height: number }

export type TooltipPlacement = {
  position: TooltipPosition
  // Viewport coordinates of the bubble's top-left corner.
  left: number
  top: number
  // Tail center along the bubble's trigger-facing edge, from that edge's start.
  tail: number
}

// Distance between the trigger and the bubble, leaving room for the 4px tail.
const GAP = 8
// Breathing room so a bubble never sits flush against the bounds.
const MARGIN = 4
// Keeps the tail clear of the bubble's rounded corners.
const TAIL_INSET = 12

const OPPOSITE: Record<TooltipPosition, TooltipPosition> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max))

export function intersectRects(a: Rect, b: Rect): Rect {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
}

function pickSide(
  preferred: TooltipPosition,
  trigger: Rect,
  bubble: Size,
  bounds: Rect,
): TooltipPosition {
  const room: Record<TooltipPosition, number> = {
    top: trigger.top - bounds.top,
    bottom: bounds.bottom - trigger.bottom,
    left: trigger.left - bounds.left,
    right: bounds.right - trigger.right,
  }
  const need =
    preferred === "top" || preferred === "bottom"
      ? bubble.height + GAP + MARGIN
      : bubble.width + GAP + MARGIN
  if (room[preferred] >= need) return preferred
  const opposite = OPPOSITE[preferred]
  return room[opposite] > room[preferred] ? opposite : preferred
}

export function placeTooltip({
  trigger,
  bubble,
  viewport,
  arena,
  preferred,
}: {
  trigger: Rect
  bubble: Size
  viewport: Rect
  // A narrower area to prefer, e.g. the page column beside the sidebar rail.
  // Ignored when the bubble cannot fit inside it.
  arena?: Rect
  preferred: TooltipPosition
}): TooltipPlacement {
  const bounds =
    arena &&
    arena.right - arena.left >= bubble.width + 2 * MARGIN &&
    arena.bottom - arena.top >= bubble.height + 2 * MARGIN
      ? arena
      : viewport
  const position = pickSide(preferred, trigger, bubble, bounds)
  const centerX = (trigger.left + trigger.right) / 2
  const centerY = (trigger.top + trigger.bottom) / 2

  if (position === "top" || position === "bottom") {
    const left = clamp(
      centerX - bubble.width / 2,
      bounds.left + MARGIN,
      bounds.right - MARGIN - bubble.width,
    )
    const top =
      position === "top"
        ? trigger.top - GAP - bubble.height
        : trigger.bottom + GAP
    const tail = clamp(centerX - left, TAIL_INSET, bubble.width - TAIL_INSET)
    return { position, left, top, tail }
  }

  const top = clamp(
    centerY - bubble.height / 2,
    bounds.top + MARGIN,
    bounds.bottom - MARGIN - bubble.height,
  )
  const left =
    position === "left"
      ? trigger.left - GAP - bubble.width
      : trigger.right + GAP
  const tail = clamp(centerY - top, TAIL_INSET, bubble.height - TAIL_INSET)
  return { position, left, top, tail }
}
