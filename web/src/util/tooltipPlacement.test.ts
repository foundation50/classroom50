import { describe, expect, it } from "vitest"
import { intersectRects, placeTooltip } from "./tooltipPlacement"

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
})

const viewport = box(0, 0, 1280, 900)
// The 320px-wide bubble every long help text reaches (max-w 20rem).
const bubble = { width: 320, height: 90 }

describe("placeTooltip", () => {
  it("centers a bubble that fits and points the tail at the trigger", () => {
    const trigger = box(350, 600, 24, 24)
    const placed = placeTooltip({
      trigger,
      bubble,
      viewport,
      preferred: "bottom",
    })
    expect(placed.position).toBe("bottom")
    expect(placed.left).toBe(362 - 160)
    expect(placed.top).toBe(624 + 8)
    expect(placed.left + placed.tail).toBe(362)
  })

  // Issue #1026 as measured: the Grading help icon sat at x=350 beside a 240px
  // sidebar rail, so a centered 320px bubble started at x=190, under the rail.
  // With the page column as arena, the bubble hugs the column's start edge.
  it("keeps the bubble inside the page column beside the sidebar rail (#1026)", () => {
    const trigger = box(350, 600, 24, 24)
    const placed = placeTooltip({
      trigger,
      bubble,
      viewport,
      arena: box(240, 0, 1040, 900),
      preferred: "bottom",
    })
    expect(placed.left).toBe(244)
    expect(placed.left + placed.tail).toBe(362)
  })

  // A phone-width column narrower than the bubble would push it off screen, so
  // the arena yields to the viewport.
  it("ignores an arena the bubble cannot fit inside", () => {
    const placed = placeTooltip({
      trigger: box(300, 600, 24, 24),
      bubble,
      viewport: box(0, 0, 414, 900),
      arena: box(240, 0, 174, 900),
      preferred: "bottom",
    })
    expect(placed.left).toBe(414 - 4 - 320)
    expect(placed.left + bubble.width).toBeLessThanOrEqual(414)
  })

  it("clamps to the viewport start and slides the tail toward the trigger", () => {
    const placed = placeTooltip({
      trigger: box(40, 600, 24, 24),
      bubble,
      viewport,
      preferred: "bottom",
    })
    expect(placed.left).toBe(4)
    expect(placed.left + placed.tail).toBe(52)
    expect(placed.left + bubble.width).toBeLessThanOrEqual(viewport.right)
  })

  it("clamps to the viewport end", () => {
    const placed = placeTooltip({
      trigger: box(1240, 600, 24, 24),
      bubble,
      viewport,
      preferred: "top",
    })
    expect(placed.left + bubble.width).toBe(1276)
    expect(placed.left + placed.tail).toBe(1252)
    expect(placed.top).toBe(600 - 8 - 90)
  })

  it("keeps the tail clear of the rounded corners even at the very edge", () => {
    const placed = placeTooltip({
      trigger: box(0, 600, 8, 24),
      bubble,
      viewport,
      preferred: "bottom",
    })
    expect(placed.tail).toBe(12)
  })

  it("flips bottom to top when the viewport ends right below the trigger", () => {
    const placed = placeTooltip({
      trigger: box(700, 850, 24, 24),
      bubble,
      viewport,
      preferred: "bottom",
    })
    expect(placed.position).toBe("top")
    expect(placed.top).toBe(850 - 8 - 90)
  })

  it("flips left to right when the trigger sits at the viewport start", () => {
    const placed = placeTooltip({
      trigger: box(10, 400, 24, 24),
      bubble,
      viewport,
      preferred: "left",
    })
    expect(placed.position).toBe("right")
    expect(placed.left).toBe(34 + 8)
    // Vertically centered on the trigger, tail at the trigger's center.
    expect(placed.top).toBe(412 - 45)
    expect(placed.top + placed.tail).toBe(412)
  })

  it("keeps the preferred side when neither side has room", () => {
    const placed = placeTooltip({
      trigger: box(140, 400, 24, 24),
      bubble,
      viewport: box(0, 0, 300, 900),
      preferred: "left",
    })
    expect(placed.position).toBe("left")
  })

  it("clamps a side bubble to the viewport top and bottom", () => {
    const high = placeTooltip({
      trigger: box(700, 10, 24, 24),
      bubble,
      viewport,
      preferred: "right",
    })
    expect(high.top).toBe(4)
    expect(high.top + high.tail).toBe(22)
    const low = placeTooltip({
      trigger: box(700, 870, 24, 24),
      bubble,
      viewport,
      preferred: "right",
    })
    expect(low.top + bubble.height).toBe(896)
    expect(low.top + low.tail).toBe(882)
  })

  // An unmeasurable bubble (no layout engine) must leave the caller's side
  // untouched rather than inventing a flip.
  it("keeps the preferred side for a zero-size bubble", () => {
    const placed = placeTooltip({
      trigger: box(0, 0, 24, 24),
      bubble: { width: 0, height: 0 },
      viewport: box(0, 0, 100, 100),
      preferred: "bottom",
    })
    expect(placed.position).toBe("bottom")
  })
})

describe("intersectRects", () => {
  it("clamps a tall page column to the viewport", () => {
    expect(
      intersectRects(box(0, 0, 1280, 900), box(240, -300, 1040, 3000)),
    ).toEqual(box(240, 0, 1040, 900))
  })
})
