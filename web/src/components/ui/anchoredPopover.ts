import { useLayoutEffect, type RefObject } from "react"

import {
  intersectRects,
  placeOverlay,
  type OverlayAlign,
  type OverlaySide,
  type Rect,
} from "@/util/overlayPlacement"

export type { OverlayAlign, OverlaySide } from "@/util/overlayPlacement"

// Shared machinery for every anchored overlay (Tooltip, DropdownMenu, Combobox,
// Popover): the panel is a `popover` element, so it renders in the browser's
// top layer where no `overflow` ancestor can clip it and no z-indexed sibling
// (the sidebar rail, a modal) can paint over it. This hook shows and hides it
// and positions it in viewport coordinates against its anchor on open and on
// every scroll or resize while open (see placeOverlay for the geometry).
//
// Bounds default to the viewport. An ancestor can spread `overlayArenaProps` to
// narrow them, so a panel stays inside e.g. the page column instead of
// straddling the sidebar rail; that is a legibility choice, not a clipping
// constraint.

const ARENA_ATTR = "data-overlay-arena"

// Spread onto the element whose box descendant overlays should stay inside.
export const overlayArenaProps = { [ARENA_ATTR]: "" } as const

// Popover support arrived in every evergreen engine in 2024; without it the
// panel still shows (position: fixed, toggled via data-open) but can be
// clipped like before.
const supportsPopover =
  typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype

function showPanel(panel: HTMLElement) {
  if (supportsPopover) {
    if (panel.isConnected && !panel.matches(":popover-open")) {
      panel.showPopover()
    }
  }
  panel.dataset.open = ""
}

function hidePanel(panel: HTMLElement) {
  if (supportsPopover && panel.matches(":popover-open")) panel.hidePopover()
  delete panel.dataset.open
}

function viewportRect(): Rect {
  return {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  }
}

function arenaRect(anchor: HTMLElement): Rect | undefined {
  const arena = anchor.closest(`[${ARENA_ATTR}]`)
  return arena
    ? intersectRects(viewportRect(), arena.getBoundingClientRect())
    : undefined
}

// daisyUI-style start/end follow the inline direction; the geometry is
// physical, so RTL swaps them for horizontal alignment. Vertical alignment
// (side left/right) is block-relative and needs no swap.
function physicalAlign(
  align: OverlayAlign,
  side: OverlaySide,
  anchor: HTMLElement,
): OverlayAlign {
  if (align === "center" || side === "left" || side === "right") return align
  const rtl = getComputedStyle(anchor).direction === "rtl"
  if (!rtl) return align
  return align === "start" ? "end" : "start"
}

function positionPanel({
  anchor,
  panel,
  side,
  align,
  gap,
  matchAnchorWidth,
}: {
  anchor: HTMLElement
  panel: HTMLElement
  side: OverlaySide
  align: OverlayAlign
  gap: number
  matchAnchorWidth: boolean
}) {
  const anchorRect = anchor.getBoundingClientRect()
  if (matchAnchorWidth) panel.style.width = `${anchorRect.width}px`
  const size = panel.getBoundingClientRect()
  const placed = placeOverlay({
    anchor: anchorRect,
    overlay: { width: size.width, height: size.height },
    viewport: viewportRect(),
    arena: arenaRect(anchor),
    preferred: side,
    align: physicalAlign(align, side, anchor),
    gap,
  })
  panel.dataset.side = placed.side
  panel.style.left = `${placed.left}px`
  panel.style.top = `${placed.top}px`
  panel.style.setProperty("--overlay-tail", `${placed.tail}px`)
}

export function useAnchoredPopover({
  open,
  anchorRef,
  panelRef,
  side = "bottom",
  align = "center",
  gap,
  matchAnchorWidth = false,
  contentKey,
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLElement | null>
  side?: OverlaySide
  align?: OverlayAlign
  gap: number
  // Size the panel to the anchor's width (a combobox listbox under its input).
  matchAnchorWidth?: boolean
  // Re-measure when this changes (e.g. the tooltip text), since the panel's
  // size may have changed while open.
  contentKey?: unknown
}) {
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    if (!open) {
      hidePanel(panel)
      return
    }
    // Show first: a hidden popover has no box to measure.
    showPanel(panel)
    const reposition = () =>
      positionPanel({ anchor, panel, side, align, gap, matchAnchorWidth })
    reposition()
    // Capture phase so scrolls inside nested containers (a table frame, a
    // modal box) count too; the anchor moves with them.
    window.addEventListener("scroll", reposition, {
      capture: true,
      passive: true,
    })
    window.addEventListener("resize", reposition)
    // Content can change size while open (a disclosure inside a menu, async
    // results arriving in a combobox); a panel placed above its anchor would
    // otherwise grow down over it. Guarded: happy-dom has no ResizeObserver.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(reposition)
    observer?.observe(panel)
    observer?.observe(anchor)
    return () => {
      window.removeEventListener("scroll", reposition, { capture: true })
      window.removeEventListener("resize", reposition)
      observer?.disconnect()
      hidePanel(panel)
    }
  }, [
    open,
    anchorRef,
    panelRef,
    side,
    align,
    gap,
    matchAnchorWidth,
    contentKey,
  ])
}
