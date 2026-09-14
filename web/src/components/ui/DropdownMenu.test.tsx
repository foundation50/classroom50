// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { DropdownMenu, type DropdownTriggerProps } from "./DropdownMenu"

afterEach(() => cleanup())

// Pins the tabindex the trigger recipe owns (see DropdownMenu.tsx, #987).
describe("DropdownMenu.Trigger", () => {
  it("renders a Button with an explicit tabindex", () => {
    render(
      <DropdownMenu.Trigger variant="primary" size="sm">
        Actions
      </DropdownMenu.Trigger>,
    )
    const trigger = screen.getByRole("button", { name: "Actions" })
    expect(trigger.getAttribute("tabindex")).toBe("0")
    expect(trigger.className).toContain("btn-primary")
    expect(trigger.getAttribute("type")).toBe("button")
  })

  it("keeps the tabindex while loading, so the trigger stays focusable", () => {
    render(
      <DropdownMenu.Trigger loading loadingLabel="Working">
        Actions
      </DropdownMenu.Trigger>,
    )
    const trigger = screen.getByRole("button", { name: /Actions/ })
    expect(trigger.getAttribute("tabindex")).toBe("0")
    expect(trigger.getAttribute("aria-disabled")).toBe("true")
  })

  it("wins over a tabIndex smuggled in through a spread", () => {
    // A spread bypasses the Omit at compile time, so the recipe must apply last.
    const smuggled = { tabIndex: -1 } as DropdownTriggerProps
    render(<DropdownMenu.Trigger {...smuggled}>Actions</DropdownMenu.Trigger>)
    expect(
      screen.getByRole("button", { name: "Actions" }).getAttribute("tabindex"),
    ).toBe("0")
  })

  it("rejects tabIndex as a direct prop", () => {
    const rejected = () => (
      // @ts-expect-error tabIndex is owned by the recipe
      <DropdownMenu.Trigger tabIndex={-1}>Actions</DropdownMenu.Trigger>
    )
    expect(typeof rejected).toBe("function")
  })
})
