// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { Input } from "./Input"

afterEach(cleanup)

describe("Input", () => {
  it("renders the bordered convention and defaults to type text", () => {
    render(<Input aria-label="name" />)
    const el = screen.getByLabelText("name")
    expect(el.className).toContain("input")
    expect(el.className).toContain("input-bordered")
    expect(el.className).toContain("w-full")
    expect(el.getAttribute("type")).toBe("text")
  })

  it("adds input-error and aria-invalid when invalid", () => {
    render(<Input aria-label="e" invalid />)
    const el = screen.getByLabelText("e")
    expect(el.className).toContain("input-error")
    expect(el.getAttribute("aria-invalid")).toBe("true")
  })

  it("maps the size prop and appends className last", () => {
    render(<Input aria-label="s" inputSize="sm" className="font-mono" />)
    const cls = screen.getByLabelText("s").className
    expect(cls).toContain("input-sm")
    expect(cls).toContain("w-full")
    expect(cls.endsWith("font-mono")).toBe(true)
  })

  it("drops the default w-full when the caller sets a width", () => {
    render(<Input aria-label="w" className="w-32" />)
    const cls = screen.getByLabelText("w").className
    expect(cls).not.toContain("w-full")
    expect(cls).toContain("w-32")
  })

  it("renders a leading icon inside a single bordered shell", () => {
    render(
      <Input
        aria-label="search"
        leadingIcon={<svg data-testid="icon" />}
        inputSize="sm"
      />,
    )
    const input = screen.getByLabelText("search")
    // The <input> is a bare grower; the border lives on the wrapping label.
    expect(input.className).toBe("grow")
    const label = input.closest("label")!
    expect(label.className).toContain("input")
    expect(label.className).toContain("input-bordered")
    expect(label.className).toContain("input-sm")
    // Exactly one element owns the border recipe (no double border).
    expect(input.className).not.toContain("input-bordered")
    expect(screen.getByTestId("icon")).not.toBeNull()
  })
})
