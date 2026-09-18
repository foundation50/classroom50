// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { StrictMode } from "react"

import {
  Dropdown,
  DropdownMenu,
  useDropdown,
  type DropdownTriggerProps,
} from "./DropdownMenu"

// A plain anchor stands in for the router Link so the menu stays mounted after
// the click and its close/refocus can be asserted.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({
      to,
      children,
      onClick,
    }: {
      to: string
      children: React.ReactNode
      onClick?: React.MouseEventHandler<HTMLAnchorElement>
    }) => (
      <a href={to} onClick={onClick}>
        {children}
      </a>
    ),
  }
})

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

  // WebKit does not focus a plain <button> on mousedown; the focused item
  // blurs toward the nearest focusable ancestor. The menu must be that
  // ancestor, or the root's focusout closes the menu before the click lands.
  it("keeps the menu mouse-focusable so an item mousedown stays inside the root", () => {
    renderMenu()
    fireEvent.click(screen.getByRole("button", { name: "Actions" }))
    expect(screen.getByRole("menu").getAttribute("tabindex")).toBe("-1")
  })

  it("stays open when focus moves within the widget, closes when it leaves", () => {
    render(
      <>
        <Dropdown>
          <DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>
          <DropdownMenu>
            <DropdownMenu.Item label="First" onSelect={() => {}} />
          </DropdownMenu>
        </Dropdown>
        <button type="button">Outside</button>
      </>,
    )
    const trigger = screen.getByRole("button", { name: "Actions" })
    fireEvent.click(trigger)
    const first = screen.getByRole("button", { name: "First" })
    fireEvent.focusOut(first, { relatedTarget: screen.getByRole("menu") })
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    fireEvent.focusOut(first, {
      relatedTarget: screen.getByRole("button", { name: "Outside" }),
    })
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
  })

  // React double-invokes state updaters in StrictMode; notifying from inside
  // one would report each transition twice (and set a parent's state
  // mid-render).
  it("reports each open-state transition exactly once under StrictMode", () => {
    const onOpenChange = vi.fn()
    render(
      <StrictMode>
        <Dropdown onOpenChange={onOpenChange}>
          <DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>
          <DropdownMenu>
            <DropdownMenu.Item label="First" onSelect={() => {}} />
          </DropdownMenu>
        </Dropdown>
      </StrictMode>,
    )
    const trigger = screen.getByRole("button", { name: "Actions" })
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
  })

  it("closes from a custom row through useDropdown()", () => {
    const CustomRow = () => {
      const { close } = useDropdown()
      return (
        <li>
          <button type="button" onClick={() => close({ returnFocus: true })}>
            Go somewhere
          </button>
        </li>
      )
    }
    render(
      <Dropdown>
        <DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>
        <DropdownMenu>
          <CustomRow />
        </DropdownMenu>
      </Dropdown>,
    )
    const trigger = screen.getByRole("button", { name: "Actions" })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("button", { name: "Go somewhere" }))
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(trigger)
  })

  it("marks the selected row of a pick-one menu and closes after picking", () => {
    const onSelect = vi.fn()
    render(
      <Dropdown>
        <DropdownMenu.Trigger>Version</DropdownMenu.Trigger>
        <DropdownMenu>
          <DropdownMenu.Item label="3.13" selected onSelect={onSelect} />
          <DropdownMenu.Item
            label="3.12"
            selected={false}
            onSelect={onSelect}
          />
        </DropdownMenu>
      </Dropdown>,
    )
    const trigger = screen.getByRole("button", { name: "Version" })
    fireEvent.click(trigger)
    const chosen = screen.getByRole("button", { name: "3.13" })
    const other = screen.getByRole("button", { name: "3.12" })
    expect(chosen.className).toContain("active")
    expect(other.className).not.toContain("active")
    // Both rows reserve the check slot so their labels line up.
    expect(chosen.querySelector("svg")?.classList.contains("invisible")).toBe(
      false,
    )
    expect(other.querySelector("svg")?.classList.contains("invisible")).toBe(
      true,
    )
    fireEvent.click(other)
    expect(onSelect).toHaveBeenCalledOnce()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
  })

  it("closes and refocuses the trigger from a RouterLinkItem", () => {
    const RouterMenu = DropdownMenu.RouterLinkItem as (props: {
      label: string
      to: string
    }) => React.ReactElement
    render(
      <Dropdown>
        <DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>
        <DropdownMenu>
          <RouterMenu label="Edit" to="/settings" />
        </DropdownMenu>
      </Dropdown>,
    )
    const trigger = screen.getByRole("button", { name: "Actions" })
    fireEvent.click(trigger)
    const link = screen.getByRole("link", { name: "Edit" })
    expect(link.getAttribute("href")).toBe("/settings")
    fireEvent.click(link)
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(trigger)
  })

  // daisyUI draws the divider through `.menu :where(li:empty)`, so the
  // separator must stay an empty <li> that is a direct child of the menu list.
  it("renders the separator as an empty list item the arrows skip", () => {
    render(
      <Dropdown>
        <DropdownMenu.Trigger>Actions</DropdownMenu.Trigger>
        <DropdownMenu>
          <DropdownMenu.Item label="First" onSelect={() => {}} />
          <DropdownMenu.Separator />
          <DropdownMenu.Item label="Second" onSelect={() => {}} />
        </DropdownMenu>
      </Dropdown>,
    )
    const trigger = screen.getByRole("button", { name: "Actions" })
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    const menu = screen.getByRole("menu")
    const separator = menu.querySelector('[role="separator"]')
    expect(separator?.tagName).toBe("LI")
    expect(separator?.parentElement).toBe(menu)
    expect(separator?.childNodes.length).toBe(0)

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "First" }),
    )
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Second" }),
    )
  })
})
