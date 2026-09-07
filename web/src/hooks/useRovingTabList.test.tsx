// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { useState } from "react"

import { useRovingTabList } from "./useRovingTabList"

const TABS = ["one", "two", "three"] as const

function Probe() {
  const [active, setActive] = useState(0)
  const tabProps = useRovingTabList(TABS.length, active)
  return (
    <div role="tablist">
      {TABS.map((label, index) => (
        <button
          key={label}
          type="button"
          role="tab"
          aria-selected={index === active}
          onClick={() => setActive(index)}
          {...tabProps(index)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

describe("useRovingTabList", () => {
  it("keeps only the active tab in the page tab order", () => {
    render(<Probe />)
    const tabs = screen.getAllByRole("tab")
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
  })

  it("moves focus with arrow keys, wrapping at the ends", () => {
    render(<Probe />)
    const tabs = screen.getAllByRole("tab")
    tabs[0].focus()

    fireEvent.keyDown(tabs[0], { key: "ArrowRight" })
    expect(document.activeElement).toBe(tabs[1])

    // Wrap backward from the first tab to the last.
    fireEvent.keyDown(tabs[1], { key: "ArrowLeft" })
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" })
    expect(document.activeElement).toBe(tabs[2])
  })

  it("jumps to the ends with Home and End", () => {
    render(<Probe />)
    const tabs = screen.getAllByRole("tab")
    tabs[0].focus()

    fireEvent.keyDown(tabs[0], { key: "End" })
    expect(document.activeElement).toBe(tabs[2])
    fireEvent.keyDown(tabs[2], { key: "Home" })
    expect(document.activeElement).toBe(tabs[0])
  })

  it("moves focus without activating (manual activation)", () => {
    render(<Probe />)
    const tabs = screen.getAllByRole("tab")
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" })
    // Focus moved but selection stayed — activation needs a click/Enter.
    expect(tabs[0].getAttribute("aria-selected")).toBe("true")
    expect(tabs[1].getAttribute("aria-selected")).toBe("false")
  })
})
