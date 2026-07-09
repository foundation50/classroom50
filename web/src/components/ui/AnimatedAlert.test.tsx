// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { AnimatedAlert } from "./AnimatedAlert"

afterEach(cleanup)

describe("AnimatedAlert", () => {
  it("renders the wrapped Alert with tone + role when shown", () => {
    render(
      <AnimatedAlert tone="error" show>
        boom
      </AnimatedAlert>,
    )
    const el = screen.getByRole("alert")
    expect(el.className).toContain("alert-error")
    expect(el.className).toContain("alert-soft")
    expect(el.textContent).toBe("boom")
    // The collapse wrapper clips the margin/height animation.
    expect(el.parentElement?.className).toContain("overflow-hidden")
  })

  it("renders nothing when not shown", () => {
    render(
      <AnimatedAlert tone="success" show={false}>
        nope
      </AnimatedAlert>,
    )
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByText("nope")).toBeNull()
  })

  it("forwards role and className to the inner Alert", () => {
    render(
      <AnimatedAlert tone="warning" show role="status" className="mt-4 text-sm">
        heads up
      </AnimatedAlert>,
    )
    const el = screen.getByRole("status")
    expect(el.className).toContain("alert-warning")
    expect(el.className).toContain("mt-4")
    expect(el.className).toContain("text-sm")
  })

  it("keeps the exiting content when show flips false and children clear", () => {
    // Callers usually clear the message string in the same render that flips
    // `show` off. AnimatePresence animates out the snapshot it last rendered, so
    // the text must not blank mid-collapse.
    const { rerender } = render(
      <AnimatedAlert tone="error" show>
        original message
      </AnimatedAlert>,
    )
    rerender(
      <AnimatedAlert tone="error" show={false}>
        {""}
      </AnimatedAlert>,
    )
    expect(screen.getByRole("alert").textContent).toBe("original message")
  })
})
