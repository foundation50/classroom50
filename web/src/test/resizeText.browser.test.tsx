import { afterEach, describe, expect, it } from "vitest"
import { render } from "@testing-library/react"

import { Card } from "@/components/ui"
import { fitsViewportWidth } from "@/util/a11y/a11yStructural"
import { descendantWidths, setupBrowserA11y, VIEWPORT } from "./browserA11y"

// 1.4.4 Resize Text: text scales to 200% without loss of content. The browser-
// testable proxy is that the app's text sizing is relative (rem/em), so bumping
// the root font-size actually enlarges text AND the layout still fits its
// container without clipping. Measured in real Chromium (happy-dom has no layout,
// so font-size changes never reflow and the check would silently pass). This is
// the representative-sample scope (KTD5): it proves the shared primitives scale,
// not every route.
const ROOT_PX = 16
const ZOOM = 2 // 200%

setupBrowserA11y()

// This guard mutates the root font-size, so it needs a reset beyond the shared
// harness's cleanup (the harness owns theme + tree cleanup).
afterEach(() => {
  document.documentElement.style.fontSize = ""
})

function sample() {
  return (
    <div style={{ width: VIEWPORT }}>
      <Card>
        <Card.Body>
          <h2>Accessibility</h2>
          <p data-testid="copy">
            A paragraph of body copy that must remain fully visible when text is
            enlarged to 200%, wrapping rather than clipping or overflowing.
          </p>
        </Card.Body>
      </Card>
    </div>
  )
}

describe("1.4.4 Resize Text — 200% scaling on shared primitives", () => {
  it("enlarging the root font to 200% actually scales text (relative units)", () => {
    document.documentElement.style.fontSize = `${ROOT_PX}px`
    const { getByTestId, rerender } = render(sample())
    const copyBefore = getByTestId("copy")
    const before = copyBefore.getBoundingClientRect().height
    const fontBefore = parseFloat(getComputedStyle(copyBefore).fontSize)

    document.documentElement.style.fontSize = `${ROOT_PX * ZOOM}px`
    rerender(sample())
    const copyAfter = getByTestId("copy")
    const after = copyAfter.getBoundingClientRect().height
    const fontAfter = parseFloat(getComputedStyle(copyAfter).fontSize)

    // rem/em text grows with the root; a fixed-px design would not. Height, not
    // width — the paragraph is width-constrained by the viewport and reflows down.
    expect(after, `${before} -> ${after}`).toBeGreaterThan(before)
    // Pin that the text is genuinely relative-unit: the computed font-size must
    // track the root (a px-hardcoded primitive would stay flat and fail here,
    // catching a future regression away from rem/em text sizing).
    expect(fontAfter, `font ${fontBefore} -> ${fontAfter}`).toBeGreaterThan(
      fontBefore * 1.5,
    )
  })

  it("at 200% the sample still fits the viewport without horizontal overflow", () => {
    document.documentElement.style.fontSize = `${ROOT_PX * ZOOM}px`
    const { container } = render(sample())
    const widths = descendantWidths(container)
    const widest = Math.max(...widths)
    expect(fitsViewportWidth(widths, VIEWPORT), `widest: ${widest}px`).toBe(
      true,
    )
  })

  // Fidelity: a fixed-height clipping box whose text overflows when enlarged must
  // be detected, so a future measurement regression can't silently pass.
  it("detects clipping when enlarged text overflows a fixed-height box (guard bites)", () => {
    document.documentElement.style.fontSize = `${ROOT_PX * ZOOM}px`
    const { getByTestId } = render(
      <div
        data-testid="clip"
        style={{ height: 16, overflow: "hidden", width: VIEWPORT }}
      >
        <span style={{ fontSize: "2rem" }}>Text taller than its 16px box</span>
      </div>,
    )
    const box = getByTestId("clip")
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight)
  })
})
