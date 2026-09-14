// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import { DropdownMenu } from "./DropdownMenu"

afterEach(() => cleanup())

// daisyUI opens the menu on focus, and Safari only focuses a button on click
// when tabindex is set explicitly (#987). The trigger recipe owns that
// attribute so no call site has to remember it.
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
})
