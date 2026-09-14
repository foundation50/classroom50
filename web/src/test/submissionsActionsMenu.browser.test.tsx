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
    // Provider-backed click preserves WebKit's native lack of button focus.
    // fireEvent/user-event or calling focus() here would hide the regression.
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
    await expect
      .element(
        page.getByRole("button", {
          name: "submissions.regradeAll.active",
          exact: true,
        }),
      )
      .toHaveAttribute("aria-disabled", "true")
    await expect
      .element(screen.getByRole("menu", { hidden: true }))
      .not.toBeVisible()
  })
})
