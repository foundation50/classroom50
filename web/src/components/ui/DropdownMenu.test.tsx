// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import {
  Dropdown,
  DropdownMenu,
  type DropdownTriggerProps,
} from "./DropdownMenu"

afterEach(() => cleanup())

const renderMenu = (triggerProps: Partial<DropdownTriggerProps> = {}) =>
  render(
    <Dropdown>
      <DropdownMenu.Trigger variant="primary" size="sm" {...triggerProps}>
        Actions
      </DropdownMenu.Trigger>
      <DropdownMenu>
        <DropdownMenu.Item label="First" onSelect={() => {}} />
        <DropdownMenu.Item label="Second" onSelect={() => {}} />
      </DropdownMenu>
    </Dropdown>,
  )

// Pins the tabindex the trigger recipe owns (see DropdownMenu.tsx, #987).
describe("DropdownMenu.Trigger", () => {
  it("renders a Button with an explicit tabindex and the menu-button ARIA", () => {
    renderMenu()
    const trigger = screen.getByRole("button", { name: "Actions" })
    expect(trigger.getAttribute("tabindex")).toBe("0")
    expect(trigger.className).toContain("btn-primary")
    expect(trigger.getAttribute("type")).toBe("button")
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(trigger.getAttribute("aria-controls")).toBe(
      screen.getByRole("menu").id,
    )
  })

  it("keeps the tabindex while loading, so the trigger stays focusable", () => {
    renderMenu({ loading: true, loadingLabel: "Working" })
    const trigger = screen.getByRole("button", { name: /Actions/ })
    expect(trigger.getAttribute("tabindex")).toBe("0")
    expect(trigger.getAttribute("aria-disabled")).toBe("true")
  })

  it("wins over a tabIndex smuggled in through a spread", () => {
    // A spread bypasses the Omit at compile time, so the recipe must apply last.
    const smuggled = { tabIndex: -1 } as DropdownTriggerProps
    renderMenu(smuggled)
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

  it("throws outside a <Dropdown>, so a menu can never lose its root", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() =>
      render(<DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>),
    ).toThrow(/inside <Dropdown>/)
    error.mockRestore()
  })
})

// Open state is explicit (not daisyUI's focus-driven CSS), so the contract is
// testable without a layout engine: the popover element is display: none in a
// browser, but the items stay in the DOM either way.
describe("Dropdown open state", () => {
  it("toggles on click and reports the change", () => {
    const onOpenChange = vi.fn()
    render(
      <Dropdown onOpenChange={onOpenChange}>
        <DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>
        <DropdownMenu>
          <DropdownMenu.Item label="First" onSelect={() => {}} />
        </DropdownMenu>
      </Dropdown>,
    )
    const trigger = screen.getByRole("button", { name: "Actions" })
    fireEvent.click(trigger)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(trigger)
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it("closes after an item acts, and acts only when enabled", () => {
    const onSelect = vi.fn()
    const onDisabled = vi.fn()
    render(
      <Dropdown>
        <DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>
        <DropdownMenu>
          <DropdownMenu.Item label="Go" onSelect={onSelect} />
          <DropdownMenu.Item label="Nope" disabled onSelect={onDisabled} />
        </DropdownMenu>
      </Dropdown>,
    )
    const trigger = screen.getByRole("button", { name: "Actions" })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("button", { name: "Go" }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(screen.getByRole("button", { name: "Nope" }))
    expect(onDisabled).not.toHaveBeenCalled()
  })

  it("closes on Escape and returns focus to the trigger", () => {
    renderMenu()
    const trigger = screen.getByRole("button", { name: "Actions" })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(trigger)
  })
})
