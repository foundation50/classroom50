// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

import PlanBadge from "./PlanBadge"

afterEach(cleanup)

const badgeClass = (container: HTMLElement) =>
  container.querySelector(".badge")?.className ?? ""

describe("PlanBadge", () => {
  it("renders nothing without a plan name (non-owners get undefined)", () => {
    const { container } = render(<PlanBadge />)
    expect(container.querySelector(".badge")).toBeNull()
  })

  // cx drops falsy fragments and trims, so an absent className can't leave a
  // stray token or a double/trailing space in the class list.
  it("emits a clean class list when className is omitted", () => {
    const { container } = render(<PlanBadge name="enterprise" />)
    const cls = badgeClass(container)
    expect(cls).toContain("capitalize")
    expect(cls.split(/\s+/)).not.toContain("undefined")
    expect(cls).not.toMatch(/\s{2}|^\s|\s$/)
  })

  it("appends a caller className", () => {
    const { container } = render(<PlanBadge name="team" className="ms-2" />)
    expect(badgeClass(container)).toContain("ms-2")
  })
})
