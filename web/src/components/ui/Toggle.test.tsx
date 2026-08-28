// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { Toggle } from "./Toggle"

afterEach(cleanup)

const getToggle = () => screen.getByRole("checkbox") as HTMLInputElement

describe("Toggle", () => {
  it("renders the primary house tone by default", () => {
    render(<Toggle aria-label="switch" />)
    expect(getToggle().className).toBe("toggle toggle-primary")
  })

  it("maps neutral/warning tones and the sm size", () => {
    render(<Toggle aria-label="switch" tone="warning" size="sm" />)
    expect(getToggle().className).toBe("toggle toggle-sm toggle-warning")
  })

  it("merges className extras and spreads input props", () => {
    render(
      <Toggle
        aria-label="switch"
        tone="neutral"
        className="mt-0.5"
        checked
        onChange={() => {}}
      />,
    )
    const toggle = getToggle()
    expect(toggle.className).toBe("toggle mt-0.5")
    expect(toggle.checked).toBe(true)
  })
})
