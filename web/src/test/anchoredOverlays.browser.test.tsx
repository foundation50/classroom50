import { beforeAll, describe, expect, it } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "@testing-library/react"
import { useState } from "react"

import { Combobox, Dropdown, DropdownMenu } from "@/components/ui"
import { setupBrowserA11y } from "./browserA11y"

// Anchored overlays (menus, combobox panels) must stay fully visible wherever
// their trigger sits: inside a scrolling table frame, a modal box, or beside a
// z-indexed sibling. This is the menu/listbox counterpart of the tooltip guard
// in tooltipPlacement.browser.test.tsx (issue #1026); happy-dom has no layout,
// so only real Chromium can prove a panel escaped its clip.
setupBrowserA11y()

beforeAll(() => page.viewport(1280, 800))

const openMenu = () =>
  document.querySelector<HTMLElement>('[role="menu"][data-open]')

const hitTest = (el: HTMLElement) => {
  const r = el.getBoundingClientRect()
  return document.elementFromPoint(
    Math.min(r.right - 8, window.innerWidth - 1),
    Math.min(r.bottom - 8, window.innerHeight - 1),
  )
}

function ClippedMenu({ align = "start" }: { align?: "start" | "end" }) {
  return (
    // A 160px-wide clipping column with a sibling painted over everything to
    // its right, like a table frame beside the sidebar rail.
    <div style={{ position: "relative", height: 400 }}>
      <div style={{ width: 160, height: 60, overflow: "hidden", padding: 8 }}>
        <Dropdown align={align}>
          <DropdownMenu.Trigger size="sm">Actions</DropdownMenu.Trigger>
          <DropdownMenu className="w-64">
            <DropdownMenu.Item label="First action" onSelect={() => {}} />
            <DropdownMenu.Item label="Second action" onSelect={() => {}} />
            <DropdownMenu.Item label="Third action" onSelect={() => {}} />
          </DropdownMenu>
        </Dropdown>
      </div>
      <div
        style={{
          position: "absolute",
          inset: "60px 0 0 0",
          zIndex: 50,
          background: "white",
        }}
      />
    </div>
  )
}

describe("DropdownMenu stays on screen", () => {
  it("is not clipped by an overflow ancestor nor covered by a z-indexed sibling", async () => {
    render(<ClippedMenu />)
    await page.getByRole("button", { name: "Actions", exact: true }).click()
    await expect.poll(openMenu).not.toBeNull()
    const menu = openMenu()!
    const r = menu.getBoundingClientRect()
    // Wider and taller than the 160x60 clipping column it was opened from.
    expect(r.width).toBeGreaterThan(200)
    expect(r.bottom).toBeGreaterThan(60)
    // Hit-test a point below the column and over the z-50 sibling: a menu
    // item is what paints there.
    const probe = hitTest(menu)
    expect(menu.contains(probe)).toBe(true)
    expect(r.left).toBeGreaterThanOrEqual(0)
    expect(r.right).toBeLessThanOrEqual(window.innerWidth)
  })

  it("keeps an end-aligned menu inside the viewport near the start edge", async () => {
    render(<ClippedMenu align="end" />)
    await page.getByRole("button", { name: "Actions", exact: true }).click()
    await expect.poll(openMenu).not.toBeNull()
    const r = openMenu()!.getBoundingClientRect()
    // End-aligning a 256px menu to a trigger at x~8 would overflow left.
    expect(r.left).toBeGreaterThanOrEqual(0)
  })

  it("opens upward when the trigger sits at the bottom of the viewport", async () => {
    render(
      <div style={{ position: "fixed", left: 300, bottom: 0 }}>
        <Dropdown>
          <DropdownMenu.Trigger size="sm">Actions</DropdownMenu.Trigger>
          <DropdownMenu className="w-64">
            <DropdownMenu.Item label="First action" onSelect={() => {}} />
            <DropdownMenu.Item label="Second action" onSelect={() => {}} />
          </DropdownMenu>
        </Dropdown>
      </div>,
    )
    const trigger = page.getByRole("button", { name: "Actions", exact: true })
    await trigger.click()
    await expect.poll(openMenu).not.toBeNull()
    const menu = openMenu()!
    expect(menu.dataset.side).toBe("top")
    expect(menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      (trigger.element() as HTMLElement).getBoundingClientRect().top,
    )
  })

  it("roves with the arrow keys and closes on Tab out", async () => {
    render(
      <div style={{ padding: 40 }}>
        <ClippedMenu />
        <button type="button">After</button>
      </div>,
    )
    await page.getByRole("button", { name: "Actions", exact: true }).click()
    await expect
      .element(page.getByRole("button", { name: "First action" }))
      .toHaveFocus()
    await userEvent.keyboard("{ArrowDown}")
    await expect
      .element(page.getByRole("button", { name: "Second action" }))
      .toHaveFocus()
    await userEvent.keyboard("{End}")
    await expect
      .element(page.getByRole("button", { name: "Third action" }))
      .toHaveFocus()
    await userEvent.keyboard("{ArrowDown}")
    await expect
      .element(page.getByRole("button", { name: "First action" }))
      .toHaveFocus()
    // Tab closes the menu and moves on from the trigger (APG menu button).
    await userEvent.tab()
    await expect.poll(openMenu).toBeNull()
    await expect
      .element(page.getByRole("button", { name: "After" }))
      .toHaveFocus()
  })
})

function FramedCombobox() {
  const [value, setValue] = useState("")
  const [open, setOpen] = useState(false)
  const items = ["ada", "bob", "cyd", "dee", "eve", "fay"]
  return (
    // A capped, scrolling frame (RosterEditMode's table) with the field on its
    // last visible row, so the listbox would once have been clipped or forced
    // the frame to scroll.
    <div
      data-testid="frame"
      style={{ height: 120, overflowY: "auto", border: "1px solid" }}
    >
      <div style={{ height: 80 }} />
      <Combobox
        id="framed"
        label="Link member"
        value={value}
        onInputChange={setValue}
        open={open}
        onOpenChange={setOpen}
        items={items}
        getItemKey={(item) => item}
        getItemLabel={(item) => item}
        renderItem={(item) => <span>{item}</span>}
        onSelect={setValue}
      />
      <div style={{ height: 200 }} />
    </div>
  )
}

describe("Combobox panel stays on screen", () => {
  it("escapes a scrolling frame and sizes itself to the input", async () => {
    render(<FramedCombobox />)
    const input = page.getByRole("combobox", { name: "Link member" })
    await input.click()
    const listbox = page.getByRole("listbox", { name: "Link member" })
    await expect.element(listbox).toBeVisible()
    const panel = (listbox.element() as HTMLElement).closest(
      "[popover]",
    ) as HTMLElement
    const frame = document.querySelector<HTMLElement>("[data-testid=frame]")!
    const p = panel.getBoundingClientRect()
    const f = frame.getBoundingClientRect()
    const i = (input.element() as HTMLElement).getBoundingClientRect()
    // Below the 120px frame, where an absolutely positioned panel was clipped.
    expect(p.bottom).toBeGreaterThan(f.bottom)
    expect(Math.round(p.width)).toBe(Math.round(i.width))
    panel.style.pointerEvents = "auto"
    expect(panel.contains(hitTest(panel))).toBe(true)
  })

  it("follows its input when the frame scrolls", async () => {
    render(<FramedCombobox />)
    const input = page.getByRole("combobox", { name: "Link member" })
    await input.click()
    const listbox = page.getByRole("listbox", { name: "Link member" })
    await expect.element(listbox).toBeVisible()
    const panel = (listbox.element() as HTMLElement).closest(
      "[popover]",
    ) as HTMLElement
    const frame = document.querySelector<HTMLElement>("[data-testid=frame]")!
    // Focusing the input may already have nudged the frame; scroll relative.
    const before = panel.getBoundingClientRect().top
    frame.scrollTop += 40
    await expect
      .poll(() => panel.getBoundingClientRect().top)
      .toBeCloseTo(before - 40, 0)
  })
})
