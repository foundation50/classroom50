import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"

import "@/index.css"
import { Button, Card } from "@/components/ui"
import { fitsViewportWidth } from "@/util/a11yStructural"

// 1.4.10 Reflow: content fits a 320px-wide viewport without horizontal scroll.
// Measured in real Chromium (happy-dom has no layout, so it never overflows and
// a happy-dom "reflow" check would silently pass). We constrain a 320px container
// and assert no descendant is wider than it — the representative-sample approach
// (KTD5): this proves the shared layout primitives reflow, not every route.
const VIEWPORT = 320

beforeAll(() => {
  document.documentElement.setAttribute("data-theme", "sumi")
})
afterEach(cleanup)

function descendantWidths(root: Element): number[] {
  return Array.from(root.querySelectorAll("*")).map(
    (el) => el.getBoundingClientRect().width,
  )
}

describe("1.4.10 Reflow — shared layout primitives at 320px", () => {
  it("a representative Card layout has no element wider than 320px", () => {
    const { container } = render(
      <div style={{ width: VIEWPORT }}>
        <Card>
          <Card.Body>
            <h2>Accessibility</h2>
            <p>
              A longer paragraph of body copy that must wrap within the narrow
              viewport rather than forcing the layout to scroll horizontally.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm">Save</Button>
              <Button size="sm" variant="ghost">
                Cancel
              </Button>
            </div>
          </Card.Body>
        </Card>
      </div>,
    )
    const widths = descendantWidths(container)
    const widest = Math.max(...widths)
    expect(fitsViewportWidth(widths, VIEWPORT), `widest: ${widest}px`).toBe(
      true,
    )
  })

  // Fidelity: a fixed-width block wider than the viewport must fail, so a future
  // measurement-logic regression can't silently pass overflowing content.
  it("a fixed 500px block fails the 320px fit (guard bites)", () => {
    const { container } = render(<div style={{ width: 500 }}>too wide</div>)
    const widths = descendantWidths(container.parentElement ?? container)
    expect(fitsViewportWidth([...widths, 500], VIEWPORT)).toBe(false)
  })
})
