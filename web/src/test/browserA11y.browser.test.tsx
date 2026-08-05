import { describe, expect, it } from "vitest"

import {
  descendantWidths,
  rect,
  renderInViewport,
  setupBrowserA11y,
  VIEWPORT,
} from "./browserA11y"

setupBrowserA11y()

describe("browserA11y harness", () => {
  it("renders in a real layout engine (non-zero measured width)", () => {
    const { container } = renderInViewport(
      <span style={{ display: "inline-block", width: 40 }}>hi</span>,
    )
    const span = container.querySelector("span") as HTMLElement
    expect(rect(span).width).toBeGreaterThan(0)
  })

  it("renderInViewport constrains the wrapper to the given width", () => {
    const { container } = renderInViewport(<span>x</span>, 200)
    const wrapper = container.firstElementChild as HTMLElement
    expect(rect(wrapper).width).toBe(200)
  })

  it("descendantWidths returns one entry per descendant element", () => {
    const { container } = renderInViewport(
      <div>
        <span>a</span>
        <span>b</span>
      </div>,
    )
    // wrapper div + inner div + 2 spans = 4 descendants under the container.
    expect(descendantWidths(container).length).toBe(4)
  })

  it("exports VIEWPORT = 320", () => {
    expect(VIEWPORT).toBe(320)
  })
})
