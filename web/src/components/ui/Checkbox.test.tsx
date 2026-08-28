// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { Checkbox } from "./Checkbox"

afterEach(cleanup)

const getBox = () => screen.getByRole("checkbox") as HTMLInputElement

describe("Checkbox", () => {
  it("renders the sm house recipe by default", () => {
    render(<Checkbox aria-label="pick" />)
    expect(getBox().className).toBe("checkbox checkbox-sm")
  })

  it("maps tones to their color classes", () => {
    render(<Checkbox aria-label="pick" tone="error" />)
    expect(getBox().className).toContain("checkbox-error")
  })

  it("drops the size class at md and merges className extras", () => {
    render(<Checkbox aria-label="pick" size="md" className="mt-0.5" />)
    const box = getBox()
    expect(box.className).not.toContain("checkbox-sm")
    expect(box.className).toContain("mt-0.5")
  })

  it("spreads input props through (checked, disabled)", () => {
    render(<Checkbox aria-label="pick" checked disabled onChange={() => {}} />)
    const box = getBox()
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(true)
  })
})
