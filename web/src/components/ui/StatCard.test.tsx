// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { StatCard } from "./StatCard"

afterEach(cleanup)

describe("StatCard", () => {
  it("renders the label and value", () => {
    render(<StatCard label="Submitted" value={12} />)
    expect(screen.getByText("Submitted")).not.toBeNull()
    expect(screen.getByText("12")).not.toBeNull()
  })

  it("renders the /outOf denominator only when provided", () => {
    const { rerender } = render(<StatCard label="A" value={3} />)
    expect(screen.queryByText(/^\//)).toBeNull()
    rerender(<StatCard label="A" value={3} outOf={10} />)
    expect(screen.getByText("/ 10")).not.toBeNull()
  })

  it("renders a hint node when provided", () => {
    render(<StatCard label="Passing" value={5} hint={<span>2 failing</span>} />)
    expect(screen.getByText("2 failing")).not.toBeNull()
  })
})
