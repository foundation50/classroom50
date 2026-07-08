// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { Alert } from "./Alert"

afterEach(cleanup)

describe("Alert", () => {
  it("renders the soft tone recipe with role=alert by default", () => {
    render(<Alert tone="error">boom</Alert>)
    const el = screen.getByRole("alert")
    expect(el.className).toContain("alert")
    expect(el.className).toContain("alert-error")
    expect(el.className).toContain("alert-soft")
    expect(el.textContent).toBe("boom")
  })

  it("drops alert-soft when soft is false", () => {
    render(<Alert tone="success" soft={false} aria-label="s" />)
    const el = screen.getByRole("alert")
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
})
