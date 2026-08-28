// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { Radio } from "./Radio"

afterEach(cleanup)

const getRadio = () => screen.getByRole("radio") as HTMLInputElement

describe("Radio", () => {
  it("renders the bare radio base by default", () => {
    render(<Radio aria-label="pick" />)
    expect(getRadio().className).toBe("radio")
  })

  it("maps size and tone and merges className extras", () => {
    render(
      <Radio aria-label="pick" size="sm" tone="primary" className="mt-0.5" />,
    )
    expect(getRadio().className).toBe("radio radio-sm radio-primary mt-0.5")
  })

  it("spreads input props through (name, value, checked)", () => {
    render(
      <Radio
        aria-label="pick"
        name="g"
        value="a"
        checked
        onChange={() => {}}
      />,
    )
    const radio = getRadio()
    expect(radio.name).toBe("g")
    expect(radio.value).toBe("a")
    expect(radio.checked).toBe(true)
  })
})
