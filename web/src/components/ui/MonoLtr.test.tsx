// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { MonoLtr } from "./MonoLtr"

afterEach(cleanup)

// MonoLtr is the bidi-isolation primitive for identifiers inside translated
// copy, so these lock the two load-bearing attributes: dir="ltr" (isolation +
// internal ordering) and font-mono, plus the className escape hatch.
describe("MonoLtr", () => {
  it("renders children in an ltr monospace span", () => {
    render(<MonoLtr>octocat/hello-world</MonoLtr>)
    const el = screen.getByText("octocat/hello-world")
    expect(el.tagName).toBe("SPAN")
    expect(el.getAttribute("dir")).toBe("ltr")
    expect(el.className).toContain("font-mono")
  })

  it("appends extra classes after the recipe", () => {
    render(<MonoLtr className="text-xs">@user</MonoLtr>)
    const cls = screen.getByText("@user").className
    expect(cls).toContain("font-mono")
    expect(cls.endsWith("text-xs")).toBe(true)
  })

  it("renders an empty span without children (Trans tag usage)", () => {
    const { container } = render(<MonoLtr />)
    const el = container.querySelector("span")
    expect(el).not.toBeNull()
    expect(el?.getAttribute("dir")).toBe("ltr")
    expect(el?.textContent).toBe("")
  })
})
