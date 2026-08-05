// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { SkeletonCell } from "./SkeletonCell"

afterEach(cleanup)

// SkeletonCell is a decorative loading placeholder. The load-bearing facts are
// that the <td> is hidden from assistive tech (also what clears the now-blocking
// control-has-associated-label rule) and that the bar utilities compose onto the
// skeleton div.
describe("SkeletonCell", () => {
  it("hides the cell from assistive tech", () => {
    const { container } = render(
      <table>
        <tbody>
          <tr>
            <SkeletonCell bar="h-4 w-40" />
          </tr>
        </tbody>
      </table>,
    )
    const td = container.querySelector("td")
    expect(td?.getAttribute("aria-hidden")).toBe("true")
  })

  it("composes the bar utilities onto the skeleton div", () => {
    const { container } = render(
      <table>
        <tbody>
          <tr>
            <SkeletonCell bar="ms-auto h-8 w-16" />
          </tr>
        </tbody>
      </table>,
    )
    const bar = container.querySelector("td > div")
    expect(bar?.className).toContain("skeleton")
    expect(bar?.className).toContain("ms-auto")
    expect(bar?.className).toContain("h-8")
  })

  it("applies optional cell-level layout", () => {
    const { container } = render(
      <table>
        <tbody>
          <tr>
            <SkeletonCell bar="h-4 w-40" tdClassName="text-end" />
          </tr>
        </tbody>
      </table>,
    )
    expect(container.querySelector("td")?.className).toContain("text-end")
  })
})
