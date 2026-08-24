// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { Alert } from "./Alert"

afterEach(cleanup)

describe("Alert", () => {
  it("renders the soft tone recipe; errors default to role=alert", () => {
    render(<Alert tone="error">boom</Alert>)
    const el = screen.getByRole("alert")
    expect(el.className).toContain("alert")
    expect(el.className).toContain("alert-error")
    expect(el.className).toContain("alert-soft")
    expect(el.textContent).toBe("boom")
  })

  it("non-error tones default to role=status", () => {
    render(<Alert tone="warning">careful</Alert>)
    expect(screen.getByRole("status")).toBeDefined()
  })

  it("drops alert-soft when soft is false", () => {
    render(<Alert tone="success" soft={false} aria-label="s" />)
    const el = screen.getByRole("status")
    expect(el.className).toContain("alert-success")
    expect(el.className).not.toContain("alert-soft")
  })

  it("honors an explicit role and appends className last", () => {
    render(
      <Alert tone="info" role="status" className="mt-4">
        i
      </Alert>,
    )
    const el = screen.getByRole("status")
    expect(el.className.endsWith("mt-4")).toBe(true)
  })

  it("renders the designated tone icon, hidden from AT; icon={null} omits it", () => {
    const { container, rerender } = render(<Alert tone="info">i</Alert>)
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    )
    rerender(
      <Alert tone="info" icon={null}>
        i
      </Alert>,
    )
    expect(container.querySelector("svg")).toBeNull()
  })

  it("renders title and a labeled dismiss button when onDismiss is given", () => {
    render(
      <Alert tone="warning" title="Heads up" onDismiss={() => {}}>
        body
      </Alert>,
    )
    expect(screen.getByText("Heads up").className).toContain("font-semibold")
    const dismiss = screen.getByRole("button")
    expect(dismiss.getAttribute("aria-label")).toBeTruthy()
  })
})
