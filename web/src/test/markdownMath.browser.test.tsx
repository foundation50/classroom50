import { describe, expect, it } from "vitest"
import { waitFor } from "@testing-library/react"

import { Markdown } from "@/components/ui"
import { fitsViewportWidth } from "@/util/a11y/a11yStructural"
import {
  descendantWidths,
  renderInViewport,
  setupBrowserA11y,
  VIEWPORT,
} from "./browserA11y"

// KaTeX output is measured in real Chromium: happy-dom has no layout, so it
// can't tell whether a wide equation widens the page or whether the math box
// really lays out left-to-right under dir="rtl".
setupBrowserA11y()

const wide = String.raw`$$
S(a,b)=\frac{b-a}{6}\left[f(a)+4f(c)+f(b)\right]+\sum_{k=1}^{n}\int_{a_k}^{b_k}\frac{\partial^2 g}{\partial x\,\partial y}\,\mathrm{d}x\,\mathrm{d}y
$$`

describe("Markdown math layout", () => {
  it("a wide display equation scrolls inside its box instead of widening the page (1.4.10)", async () => {
    const { container } = renderInViewport(<Markdown content={wide} />)
    await waitFor(() =>
      expect(container.querySelector(".katex-display")).not.toBeNull(),
    )
    // The equation itself overflows its scroller; every box up to and including
    // the scroller must still fit the 320px viewport.
    const display = container.querySelector(".katex-display")!
    const outside = Array.from(container.querySelectorAll("*")).filter(
      (el) => el === display || !display.contains(el),
    )
    const widths = outside.map((el) => el.getBoundingClientRect().width)
    expect(fitsViewportWidth(widths, VIEWPORT)).toBe(true)
    expect(display.scrollWidth).toBeGreaterThan(display.clientWidth)
    expect(descendantWidths(display).some((w) => w > VIEWPORT)).toBe(true)
  })

  it("keeps math left-to-right inside an RTL description", async () => {
    document.documentElement.dir = "rtl"
    try {
      const { container } = renderInViewport(
        <Markdown content={String.raw`نص $c=\frac{a+b}{2}$ نص`} />,
      )
      await waitFor(() =>
        expect(container.querySelector(".katex")).not.toBeNull(),
      )
      const katex = container.querySelector(".katex")!
      expect(getComputedStyle(katex).direction).toBe("ltr")
      expect(getComputedStyle(container).direction).toBe("rtl")
    } finally {
      document.documentElement.dir = "ltr"
    }
  })
})
