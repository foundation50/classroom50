// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"

import { TabList, tabId } from "./TabList"

afterEach(cleanup)

const TABS = [
  { key: "one", label: "One" },
  { key: "two", label: (active: boolean) => (active ? "Two (on)" : "Two") },
] as const

function Harness({ onChange }: { onChange?: (key: "one" | "two") => void }) {
  const [active, setActive] = useState<"one" | "two">("one")
  return (
    <>
      <TabList
        id="t"
        panelId="t-panel"
        aria-label="Demo"
        tabs={TABS}
        active={active}
        onChange={(key) => {
          setActive(key)
          onChange?.(key)
        }}
      />
      <div role="tabpanel" id="t-panel" aria-labelledby={tabId("t", active)}>
        {active}
      </div>
    </>
  )
}

describe("TabList", () => {
  it("wires the WAI-ARIA tab pattern", () => {
    render(<Harness />)
    const tablist = screen.getByRole("tablist", { name: "Demo" })
    const one = screen.getByRole("tab", { name: "One" })
    const two = screen.getByRole("tab", { name: "Two" })
    expect(tablist.contains(one)).toBe(true)
    expect(one.id).toBe("t-tab-one")
    expect(one.getAttribute("aria-selected")).toBe("true")
    expect(one.getAttribute("aria-controls")).toBe("t-panel")
    expect(two.getAttribute("aria-selected")).toBe("false")
    // Only the active tab is in the tab order; arrows move between them.
    expect(one.tabIndex).toBe(0)
    expect(two.tabIndex).toBe(-1)
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      one.id,
    )
  })

  it("selects on click and lets a label follow the active state", () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByRole("tab", { name: "Two" }))
    expect(onChange).toHaveBeenCalledWith("two")
    const two = screen.getByRole("tab", { name: "Two (on)" })
    expect(two.getAttribute("aria-selected")).toBe("true")
    expect(two.className).toContain("tab-active")
    expect(screen.getByRole("tab", { name: "One" }).className).not.toContain(
      "tab-active",
    )
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
      two.id,
    )
  })

  it("roves focus with the arrow keys", () => {
    render(<Harness />)
    const one = screen.getByRole("tab", { name: "One" })
    one.focus()
    fireEvent.keyDown(one, { key: "ArrowRight" })
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Two" }),
    )
  })

  it("renders the small size", () => {
    render(
      <TabList
        id="s"
        panelId="s-panel"
        size="sm"
        tabs={TABS}
        active="one"
        onChange={() => {}}
      />,
    )
    expect(screen.getByRole("tablist").className).toContain("tabs-sm")
  })
})
