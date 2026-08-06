import { describe, expect, it } from "vitest"

import { Button } from "@/components/ui"
import { meetsTargetSize, TARGET_SIZE_MIN } from "@/util/a11y/a11yStructural"
import { rect, renderInViewport, setupBrowserA11y } from "./browserA11y"

// 2.5.8 Target Size (Minimum): interactive targets are >= 24x24 CSS px. Measured
// in a real Chromium layout engine (happy-dom reports 0 for every box, so this
// check can only live in the browser project). daisyUI sizes come from the real
// stylesheet + theme, both applied by the shared harness.
setupBrowserA11y()

describe("2.5.8 Target Size — shared Button primitive", () => {
  // Measure every shipped action size, not just the defaults: the 2.5.8
  // "Supports" claim covers all of them, so an unmeasured size would overclaim.
  it.each(["md", "sm", "xs"] as const)(
    "a %s Button meets the 24x24 minimum",
    (size) => {
      const { getByRole } = renderInViewport(<Button size={size}>Save</Button>)
      const { width, height } = rect(getByRole("button"))
      expect(
        meetsTargetSize(width, height),
        `${size}: ${width}x${height}`,
      ).toBe(true)
    },
  )

  // The smallest icon-only target the app renders: an xs circle. Icon-only + the
  // smallest size is the worst case for the 24x24 floor, so pin it explicitly.
  it("an icon-only xs circle Button meets the 24x24 minimum", () => {
    const { getByRole } = renderInViewport(
      <Button shape="circle" size="xs" aria-label="Remove">
        <span aria-hidden="true" className="size-3" />
      </Button>,
    )
    const { width, height } = rect(getByRole("button"))
    expect(meetsTargetSize(width, height), `${width}x${height}`).toBe(true)
  })

  it("an icon-only circle Button meets the 24x24 minimum", () => {
    const { getByRole } = renderInViewport(
      <Button shape="circle" aria-label="Settings">
        <span aria-hidden="true" className="size-4" />
      </Button>,
    )
    const { width, height } = rect(getByRole("button"))
    expect(meetsTargetSize(width, height), `${width}x${height}`).toBe(true)
  })

  // Fidelity: a deliberately tiny box must fail, so a future measurement-logic
  // regression can't silently pass every element.
  it("a 10x10 target fails the minimum (guard bites)", () => {
    const { getByTestId } = renderInViewport(
      <div data-testid="tiny" style={{ width: 10, height: 10 }} />,
    )
    const { width, height } = rect(getByTestId("tiny"))
    expect(width).toBeLessThan(TARGET_SIZE_MIN)
    expect(meetsTargetSize(width, height)).toBe(false)
  })
})
