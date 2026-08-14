// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

import { Collapse } from "./Collapse"

afterEach(cleanup)

// The clip is required WHILE the height animates but must be released once open,
// or the panel permanently truncates any tooltip/dropdown a child paints outside
// its box. That release is the whole reason this component exists.
describe("Collapse", () => {
  it("renders nothing while closed", () => {
    const { container } = render(
      <Collapse open={false}>
        <p>body</p>
      </Collapse>,
    )
    expect(container.textContent).toBe("")
  })

  it("renders its children when open", () => {
    const { container } = render(
      <Collapse open>
        <p>body</p>
      </Collapse>,
    )
    expect(container.textContent).toContain("body")
  })

  it("drops overflow-hidden once the open animation settles", async () => {
    const { container } = render(
      <Collapse open>
        <p>body</p>
      </Collapse>,
    )
    const panel = container.firstElementChild as HTMLElement
    // Motion fires onAnimationComplete asynchronously; the clip must be gone by
    // then so descendant overlays aren't truncated in the resting state.
    await waitFor(() =>
      expect(panel.className).not.toContain("overflow-hidden"),
    )
  })

  it("clips while an open transition is in flight", () => {
    // The clip is still needed DURING the animation: without it the content
    // spills out of the growing/shrinking box.
    const { container, rerender } = render(
      <Collapse open={false}>
        <p>body</p>
      </Collapse>,
    )
    rerender(
      <Collapse open>
        <p>body</p>
      </Collapse>,
    )
    expect((container.firstElementChild as HTMLElement).className).toContain(
      "overflow-hidden",
    )
  })

  it("keeps a caller className alongside the managed clip", () => {
    const { container } = render(
      <Collapse open className="mt-4">
        <p>body</p>
      </Collapse>,
    )
    expect((container.firstElementChild as HTMLElement).className).toContain(
      "mt-4",
    )
  })
})
