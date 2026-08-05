import { describe, expect, it } from "vitest"

import { Button, Card } from "@/components/ui"
import { fitsViewportWidth } from "@/util/a11y/a11yStructural"
import {
  descendantWidths,
  renderInViewport,
  setupBrowserA11y,
  VIEWPORT,
} from "./browserA11y"

// 1.4.10 Reflow: content fits a 320px-wide viewport without horizontal scroll.
// Measured in real Chromium (happy-dom has no layout, so it never overflows and
// a happy-dom "reflow" check would silently pass). renderInViewport constrains
// the container to 320px and we assert no descendant is wider than it — the
// representative-sample approach (KTD5): this proves the shared layout primitives
// reflow, not every route.
setupBrowserA11y()

describe("1.4.10 Reflow — shared layout primitives at 320px", () => {
  it("a representative page composition has no element wider than 320px", () => {
    const { container } = renderInViewport(
      <>
        <Card>
          <Card.Body>
            <h2>Accessibility</h2>
            <p>
              A longer paragraph of body copy that must wrap within the narrow
              viewport rather than forcing the layout to scroll horizontally.
            </p>
            {/* A long unbroken token is the classic reflow trap — it must wrap or
                clip, not push the layout wider than the viewport. */}
            <p className="break-words">
              supercalifragilisticexpialidocious-antidisestablishmentarianism-pneumonoultramicroscopicsilicovolcanoconiosis
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm">Save changes</Button>
              <Button size="sm" variant="ghost">
                Cancel
              </Button>
            </div>
          </Card.Body>
        </Card>
        <Card>
          <Card.Body>
            <h2>A second stacked card</h2>
            <p>
              Stacked cards mirror how the real pages compose sections; both
              must stay within the viewport width.
            </p>
          </Card.Body>
        </Card>
      </>,
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
    const { container } = renderInViewport(
      <div style={{ width: 500 }}>too wide</div>,
    )
    const widths = descendantWidths(container)
    expect(fitsViewportWidth([...widths, 500], VIEWPORT)).toBe(false)
  })
})
