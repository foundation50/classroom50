import { describe, expect, it, vi } from "vitest"
import { page } from "vitest/browser"
import { render, screen } from "@testing-library/react"

import { SubmissionsActionsMenu } from "@/pages/submissions/SubmissionsActionsMenu"
import { setupBrowserA11y } from "./browserA11y"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

setupBrowserA11y()

const baseProps = {
  collecting: false,
  regrading: false,
  regradeAllActive: false,
  emptyRoster: false,
  skipsGrading: true,
  onRegradeAll: () => {},
  viewHref: "https://example.test/run",
  viewLabel: "View run",
  onDownloadCsv: () => {},
  downloadDisabled: false,
  onDownloadAll: () => {},
  downloadAllDisabled: true,
}

function renderMenu(overrides = {}) {
  render(
    <div style={{ padding: 80 }}>
      <div style={{ marginBottom: 40 }}>
        <button type="button">Outside</button>
      </div>
      <SubmissionsActionsMenu {...baseProps} {...overrides} />
    </div>,
  )
  return {
    trigger: page.getByRole("button", {
      name: "submissions.menu.actions",
      exact: true,
    }),
    menu: screen.getByRole("menu", { hidden: true }),
  }
}

describe("SubmissionsActionsMenu pointer interaction", () => {
  it("opens on click and closes after selecting an action", async () => {
    const onLockToggle = vi.fn()
    const { trigger, menu } = renderMenu({ onLockToggle })
    await expect.element(menu).not.toBeVisible()
    await trigger.click()
    await expect.element(menu).toBeVisible()
    await page
      .getByRole("button", { name: "submissions.lock.lockLabel", exact: true })
      .click()
    expect(onLockToggle).toHaveBeenCalledOnce()
    await expect.element(menu).not.toBeVisible()
  })

  it("closes on an outside click and can reopen", async () => {
    const { trigger, menu } = renderMenu()
    await trigger.click()
    await expect.element(menu).toBeVisible()
    await page.getByRole("button", { name: "Outside", exact: true }).click()
    await expect.element(menu).not.toBeVisible()
    await trigger.click()
    await expect.element(menu).toBeVisible()
  })

  it("keeps the trigger unavailable while regrading", async () => {
    renderMenu({ regrading: true })
    const trigger = page.getByRole("button", {
      name: "submissions.regradeAll.active",
      exact: true,
    })
    const menu = screen.getByRole("menu", { hidden: true })
    await expect.element(trigger).toHaveAttribute("aria-disabled", "true")
    // daisyUI drops pointer events on an aria-disabled btn, so a click cannot
    // focus it and the menu stays shut. Playwright treats aria-disabled as not
    // actionable, so the click has to be forced to reach the element at all.
    await trigger.click({ force: true })
    await expect.element(menu).not.toBeVisible()
  })
})
