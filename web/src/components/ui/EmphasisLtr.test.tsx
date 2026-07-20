// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { EmphasisLtr } from "./EmphasisLtr"

afterEach(cleanup)

// EmphasisLtr is the prose-weight bidi-isolation primitive for identifiers
// inside translated copy (MonoLtr's non-mono sibling), so these lock the two
// load-bearing attributes: dir="ltr" (isolation + internal ordering) and the
// font-semibold default, plus the className escape hatch. If dir were ever
// dropped, every identifier tag routed through this component would silently
// lose bidi isolation — that's the regression this file exists to catch.
describe("EmphasisLtr", () => {
  it("renders children in an ltr semibold span", () => {
    render(<EmphasisLtr>cs50-fall</EmphasisLtr>)
    const el = screen.getByText("cs50-fall")
    expect(el.tagName).toBe("SPAN")
    expect(el.getAttribute("dir")).toBe("ltr")
    expect(el.className).toContain("font-semibold")
  })

  it("appends extra classes after the recipe", () => {
    render(<EmphasisLtr className="text-base-content">org-name</EmphasisLtr>)
    const cls = screen.getByText("org-name").className
    expect(cls).toContain("font-semibold")
    expect(cls.endsWith("text-base-content")).toBe(true)
  })

  it("renders an empty span without children (Trans tag usage)", () => {
    const { container } = render(<EmphasisLtr />)
    const el = container.querySelector("span")
    expect(el).not.toBeNull()
    expect(el?.getAttribute("dir")).toBe("ltr")
    expect(el?.textContent).toBe("")
  })
})
