import { describe, expect, it } from "vitest"
import { intersectRects, placeOverlay } from "./overlayPlacement"

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
})

const viewport = box(0, 0, 1280, 900)
// The 320px-wide bubble every long help text reaches (max-w 20rem).
const bubble = { width: 320, height: 90 }
// A tooltip's anchor gap: 4px tail plus 4px of air.
const GAP = 8

describe("placeOverlay (centered, tooltip-style)", () => {
  it("centers an overlay that fits and points the tail at the anchor", () => {
    const anchor = box(350, 600, 24, 24)
    const placed = placeOverlay({
      anchor,
      overlay: bubble,
      viewport,
      preferred: "bottom",
      gap: GAP,
    })
    expect(placed.side).toBe("bottom")
    expect(placed.left).toBe(362 - 160)
    expect(placed.top).toBe(624 + 8)
    expect(placed.left + placed.tail).toBe(362)
  })

  // Issue #1026 as measured: the Grading help icon sat at x=350 beside a 240px
  // sidebar rail, so a centered 320px bubble started at x=190, under the rail.
  // With the page column as arena, the bubble hugs the column's start edge.
  it("keeps the overlay inside the page column beside the sidebar rail (#1026)", () => {
    const placed = placeOverlay({
      anchor: box(350, 600, 24, 24),
      overlay: bubble,
      viewport,
      arena: box(240, 0, 1040, 900),
      preferred: "bottom",
      gap: GAP,
    })
    expect(placed.left).toBe(244)
    expect(placed.left + placed.tail).toBe(362)
  })

  // A phone-width column narrower than the overlay would push it off screen,
  // so the arena yields to the viewport.
  it("ignores an arena the overlay cannot fit inside", () => {
    const placed = placeOverlay({
      anchor: box(300, 600, 24, 24),
      overlay: bubble,
      viewport: box(0, 0, 414, 900),
      arena: box(240, 0, 174, 900),
      preferred: "bottom",
      gap: GAP,
    })
    expect(placed.left).toBe(414 - 4 - 320)
    expect(placed.left + bubble.width).toBeLessThanOrEqual(414)
  })

  it("clamps to the viewport start and slides the tail toward the anchor", () => {
    const placed = placeOverlay({
      anchor: box(40, 600, 24, 24),
      overlay: bubble,
      viewport,
      preferred: "bottom",
      gap: GAP,
    })
    expect(placed.left).toBe(4)
    expect(placed.left + placed.tail).toBe(52)
  })

  it("clamps to the viewport end", () => {
    const placed = placeOverlay({
      anchor: box(1240, 600, 24, 24),
      overlay: bubble,
      viewport,
      preferred: "top",
      gap: GAP,
    })
    expect(placed.left + bubble.width).toBe(1276)
    expect(placed.left + placed.tail).toBe(1252)
    expect(placed.top).toBe(600 - 8 - 90)
  })

  it("keeps the tail clear of the rounded corners even at the very edge", () => {
    const placed = placeOverlay({
      anchor: box(0, 600, 8, 24),
      overlay: bubble,
      viewport,
      preferred: "bottom",
      gap: GAP,
    })
    expect(placed.tail).toBe(12)
  })

  it("flips bottom to top when the viewport ends right below the anchor", () => {
    const placed = placeOverlay({
      anchor: box(700, 850, 24, 24),
      overlay: bubble,
      viewport,
      preferred: "bottom",
      gap: GAP,
    })
    expect(placed.side).toBe("top")
    expect(placed.top).toBe(850 - 8 - 90)
  })

  it("flips left to right when the anchor sits at the viewport start", () => {
    const placed = placeOverlay({
      anchor: box(10, 400, 24, 24),
      overlay: bubble,
      viewport,
      preferred: "left",
      gap: GAP,
    })
    expect(placed.side).toBe("right")
    expect(placed.left).toBe(34 + 8)
    expect(placed.top).toBe(412 - 45)
    expect(placed.top + placed.tail).toBe(412)
  })

  it("keeps the preferred side when neither side has room", () => {
    const placed = placeOverlay({
      anchor: box(140, 400, 24, 24),
      overlay: bubble,
      viewport: box(0, 0, 300, 900),
      preferred: "left",
      gap: GAP,
    })
    expect(placed.side).toBe("left")
  })

  it("clamps a side overlay to the viewport top and bottom", () => {
    const high = placeOverlay({
      anchor: box(700, 10, 24, 24),
      overlay: bubble,
      viewport,
      preferred: "right",
      gap: GAP,
    })
    expect(high.top).toBe(4)
    expect(high.top + high.tail).toBe(22)
    const low = placeOverlay({
      anchor: box(700, 870, 24, 24),
      overlay: bubble,
      viewport,
      preferred: "right",
      gap: GAP,
    })
    expect(low.top + bubble.height).toBe(896)
    expect(low.top + low.tail).toBe(882)
  })

  // An unmeasurable overlay (no layout engine) must leave the caller's side
  // untouched rather than inventing a flip.
  it("keeps the preferred side for a zero-size overlay", () => {
    const placed = placeOverlay({
      anchor: box(0, 0, 24, 24),
      overlay: { width: 0, height: 0 },
      viewport: box(0, 0, 100, 100),
      preferred: "bottom",
      gap: GAP,
    })
    expect(placed.side).toBe("bottom")
  })
})

// Dropdown menus align an edge with the anchor rather than centering.
describe("placeOverlay (edge-aligned, menu-style)", () => {
  const menu = { width: 256, height: 300 }
  const trigger = box(600, 100, 120, 32)

  it("start-aligns the menu with the trigger's start edge", () => {
    const placed = placeOverlay({
      anchor: trigger,
      overlay: menu,
      viewport,
      preferred: "bottom",
      align: "start",
      gap: 4,
    })
    expect(placed.left).toBe(600)
    expect(placed.top).toBe(132 + 4)
  })

  it("end-aligns the menu with the trigger's end edge", () => {
    const placed = placeOverlay({
      anchor: trigger,
      overlay: menu,
      viewport,
      preferred: "bottom",
      align: "end",
      gap: 4,
    })
    expect(placed.left + menu.width).toBe(720)
  })

  // A toolbar menu near the viewport's end edge (the #1026 class of bug for
  // menus): the aligned position would overflow, so it is clamped instead.
  it("clamps an end-aligned menu that would overflow the viewport start", () => {
    const placed = placeOverlay({
      anchor: box(20, 100, 120, 32),
      overlay: menu,
      viewport,
      preferred: "bottom",
      align: "end",
      gap: 4,
    })
    expect(placed.left).toBe(4)
  })

  it("opens upward when the trigger sits near the viewport bottom", () => {
    const placed = placeOverlay({
      anchor: box(600, 800, 120, 32),
      overlay: menu,
      viewport,
      preferred: "bottom",
      align: "start",
      gap: 4,
    })
    expect(placed.side).toBe("top")
    expect(placed.top).toBe(800 - 4 - 300)
  })
})

describe("intersectRects", () => {
  it("clamps a tall page column to the viewport", () => {
    expect(
      intersectRects(box(0, 0, 1280, 900), box(240, -300, 1040, 3000)),
    ).toEqual(box(240, 0, 1040, 900))
  })
})
