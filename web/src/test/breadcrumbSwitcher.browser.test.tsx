import { beforeAll, describe, expect, it, vi } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "@testing-library/react"

import { CrumbSwitcher } from "@/components/breadcrumb"
import { setupBrowserA11y } from "./browserA11y"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

setupBrowserA11y()

beforeAll(() => page.viewport(1280, 800))

// The switcher's Escape listener is scoped to its wrapper, so the panel itself
// has to be able to hold focus: a click on the title or padding otherwise blurs
// the search field to <body> and Escape stops working. happy-dom does not move
// focus on click, so only real Chromium can prove this.
function Switcher() {
  return (
    <div style={{ padding: 40 }}>
      <CrumbSwitcher
        name="cs50"
        title="Switch classroom"
        searchPlaceholder="Find a classroom"
        items={["cs50", "cs51"]}
        getLabel={(item) => item}
      >
        {(visible, close) =>
          visible.map((item) => (
            <li key={item}>
              <button type="button" onClick={close}>
                {item}
              </button>
            </li>
          ))
        }
      </CrumbSwitcher>
    </div>
  )
}

describe("Breadcrumb switcher Escape", () => {
  it("still closes after a click on the panel chrome moved focus off the field", async () => {
    render(<Switcher />)
    const trigger = page.getByRole("button", { name: "Switch classroom" })
    await trigger.click()
    const panel = () =>
      document.querySelector<HTMLElement>('[role="dialog"][data-open]')
    expect(panel()).not.toBeNull()
    await expect
      .element(page.getByRole("textbox", { name: "Find a classroom" }))
      .toHaveFocus()

    await page.getByText("Switch classroom", { exact: true }).click()
    expect(document.activeElement).not.toBe(document.body)
    expect(panel()?.contains(document.activeElement)).toBe(true)

    await userEvent.keyboard("{Escape}")
    expect(panel()).toBeNull()
    await expect.element(trigger).toHaveFocus()
  })
})
