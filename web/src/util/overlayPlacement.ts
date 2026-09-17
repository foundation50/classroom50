// Placement math for every anchored overlay: tooltip bubbles, dropdown menus,
// combobox panels. Pure geometry so it is testable in node; the components
// measure the DOM and call this on every open.
//
// Overlays are top-layer popovers positioned in viewport coordinates, so
// nothing can clip or cover them; the viewport is the hard limit and an
// optional `arena` (the page column beside the sidebar rail) is where they
// should stay for legibility. The caller's `preferred` side is kept unless it
// lacks room and the opposite side has more; along the anchor's edge the
// overlay is aligned as asked, then clamped inside the bounds, and the tail (if
// any) slides to stay pointed at the anchor (issue #1026: a centered bubble
// beside a short field label ran under the sidebar rail).

export type OverlaySide = "top" | "bottom" | "left" | "right"
// Alignment along the anchor's edge, in physical terms; callers map the
// inline-relative start/end through the element's direction first.
export type OverlayAlign = "start" | "center" | "end"

export type Rect = { left: number; top: number; right: number; bottom: number }
export type Size = { width: number; height: number }

export type OverlayPlacement = {
  side: OverlaySide
  // Viewport coordinates of the overlay's top-left corner.
  left: number
  top: number
  // Tail center along the overlay's anchor-facing edge, from that edge's start.
  tail: number
}

// Breathing room so an overlay never sits flush against the bounds.
const MARGIN = 4
// Keeps a tail clear of the overlay's rounded corners.
const TAIL_INSET = 12

const OPPOSITE: Record<OverlaySide, OverlaySide> = {
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
  preferred: OverlaySide,
  anchor: Rect,
  overlay: Size,
  bounds: Rect,
  gap: number,
): OverlaySide {
  const room: Record<OverlaySide, number> = {
    top: anchor.top - bounds.top,
    bottom: bounds.bottom - anchor.bottom,
    left: anchor.left - bounds.left,
    right: bounds.right - anchor.right,
  }
  const need =
    preferred === "top" || preferred === "bottom"
      ? overlay.height + gap + MARGIN
      : overlay.width + gap + MARGIN
  if (room[preferred] >= need) return preferred
  const opposite = OPPOSITE[preferred]
  return room[opposite] > room[preferred] ? opposite : preferred
}

// Where the overlay's leading edge lands along the anchor's edge before
// clamping: flush with the anchor's start, centered, or flush with its end.
function alignedStart(
  align: OverlayAlign,
  anchorStart: number,
  anchorEnd: number,
  extent: number,
): number {
  switch (align) {
    case "start":
      return anchorStart
    case "end":
      return anchorEnd - extent
    case "center":
      return (anchorStart + anchorEnd) / 2 - extent / 2
  }
}

export function placeOverlay({
  anchor,
  overlay,
  viewport,
  arena,
  preferred,
  align = "center",
  gap,
}: {
  anchor: Rect
  overlay: Size
  viewport: Rect
  // A narrower area to prefer, e.g. the page column beside the sidebar rail.
  // Ignored when the overlay cannot fit inside it.
  arena?: Rect
  preferred: OverlaySide
  align?: OverlayAlign
  // Distance between the anchor and the overlay (room for a tail, or a menu's
  // small offset).
  gap: number
}): OverlayPlacement {
  const bounds =
    arena &&
    arena.right - arena.left >= overlay.width + 2 * MARGIN &&
    arena.bottom - arena.top >= overlay.height + 2 * MARGIN
      ? arena
      : viewport
  const side = pickSide(preferred, anchor, overlay, bounds, gap)
  const centerX = (anchor.left + anchor.right) / 2
  const centerY = (anchor.top + anchor.bottom) / 2

  if (side === "top" || side === "bottom") {
    const left = clamp(
      alignedStart(align, anchor.left, anchor.right, overlay.width),
      bounds.left + MARGIN,
      bounds.right - MARGIN - overlay.width,
    )
    const top =
      side === "top" ? anchor.top - gap - overlay.height : anchor.bottom + gap
    const tail = clamp(centerX - left, TAIL_INSET, overlay.width - TAIL_INSET)
    return { side, left, top, tail }
  }

  const top = clamp(
    alignedStart(align, anchor.top, anchor.bottom, overlay.height),
    bounds.top + MARGIN,
    bounds.bottom - MARGIN - overlay.height,
  )
  const left =
    side === "left" ? anchor.left - gap - overlay.width : anchor.right + gap
  const tail = clamp(centerY - top, TAIL_INSET, overlay.height - TAIL_INSET)
  return { side, left, top, tail }
}
