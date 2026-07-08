// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Button } from "./Button"

afterEach(cleanup)

// Button is the one prop->class mapping every `btn` site renders through, so
// these lock the recipe: variant/size/shape map to the expected daisyUI
// modifiers, `neutral` stays a bare `btn`, and loading disables + announces.
describe("Button", () => {
  it("renders a bare btn for the default neutral variant", () => {
    render(<Button>Go</Button>)
    const btn = screen.getByRole("button", { name: "Go" })
    expect(btn.className).toBe("btn")
    expect(btn.getAttribute("type")).toBe("button")
  })

  it("maps variant, size, and shape to daisyUI modifiers", () => {
    render(
      <Button variant="primary" size="sm" shape="square">
        X
      </Button>,
    )
    const cls = screen.getByRole("button", { name: "X" }).className
    expect(cls).toContain("btn")
    expect(cls).toContain("btn-primary")
    expect(cls).toContain("btn-sm")
    expect(cls).toContain("btn-square")
  })

  it("maps the outline variant to the primary outline", () => {
    render(<Button variant="outline">O</Button>)
    const cls = screen.getByRole("button", { name: "O" }).className
    expect(cls).toContain("btn-outline")
    expect(cls).toContain("btn-primary")
  })

  it("adds btn-active when active", () => {
    render(<Button active>A</Button>)
    expect(screen.getByRole("button", { name: "A" }).className).toContain(
      "btn-active",
    )
  })

  it("appends the className escape hatch last", () => {
    render(
      <Button variant="ghost" className="w-full join-item">
        E
      </Button>,
    )
    const cls = screen.getByRole("button", { name: "E" }).className
    expect(cls.endsWith("w-full join-item")).toBe(true)
  })

  it("disables and marks aria-busy while loading", () => {
    render(<Button loading>Save</Button>)
    const btn = screen.getByRole("button", { name: /Save/ })
    expect(btn.hasAttribute("disabled")).toBe(true)
    expect(btn.getAttribute("aria-busy")).toBe("true")
    expect(btn.querySelector(".loading")).not.toBeNull()
  })

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        No
      </Button>,
    )
    await userEvent.click(screen.getByRole("button", { name: "No" }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it("respects an explicit submit type", () => {
    render(
      <Button type="submit" variant="primary">
        Submit
      </Button>,
    )
    expect(
      screen.getByRole("button", { name: "Submit" }).getAttribute("type"),
    ).toBe("submit")
  })

  it("renders an anchor with the same recipe when given href", () => {
    render(
      <Button href="https://example.com" variant="ghost" size="sm">
        Open
      </Button>,
    )
    const link = screen.getByRole("link", { name: "Open" })
    expect(link.tagName).toBe("A")
    expect(link.getAttribute("href")).toBe("https://example.com")
    const cls = link.className
    expect(cls).toContain("btn")
    expect(cls).toContain("btn-ghost")
    expect(cls).toContain("btn-sm")
  })

  it("forwards target and rel on the anchor variant", () => {
    render(
      <Button
        as="a"
        href="https://example.com"
        target="_blank"
        rel="noreferrer"
      >
        Ext
      </Button>,
    )
    const link = screen.getByRole("link", { name: "Ext" })
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noreferrer")
  })

  it("makes a disabled anchor inert (no href, aria-disabled)", () => {
    render(
      <Button as="a" href="https://example.com" disabled>
        Dead
      </Button>,
    )
    const link = screen.getByText("Dead").closest("a")!
    expect(link.hasAttribute("href")).toBe(false)
    expect(link.getAttribute("aria-disabled")).toBe("true")
  })
})
