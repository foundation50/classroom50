// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { UserPreferencesProvider } from "@/context/userPreferences/UserPreferencesProvider"
import { ANALYTICS_STORAGE_KEY } from "@/types/preferences"
import { AnalyticsPreferenceForm } from "./AnalyticsPreferenceForm"

vi.mock("react-i18next", async (importActual) => {
  const actual = await importActual<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

// happy-dom doesn't back window.localStorage here; the registry needs a store.
function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
    configurable: true,
  })
}

const renderForm = () =>
  render(
    <UserPreferencesProvider>
      <AnalyticsPreferenceForm />
    </UserPreferencesProvider>,
  )
const radio = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement

beforeEach(installLocalStorage)
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

// The form is what the public /privacy page renders, so a visitor who never
// signs in can still object. It must write exactly the literal the analytics
// loader in index.html checks for.
describe("AnalyticsPreferenceForm", () => {
  it("opts out with the literal 'off' on Save, and only then", async () => {
    renderForm()
    expect(radio("settings.analytics.on").checked).toBe(true)

    await userEvent.click(radio("settings.analytics.off"))
    expect(window.localStorage.getItem(ANALYTICS_STORAGE_KEY)).toBeNull()

    await userEvent.click(screen.getByText("common.save"))
    expect(window.localStorage.getItem(ANALYTICS_STORAGE_KEY)).toBe("off")
    expect(screen.getByText("settings.analytics.saved")).toBeTruthy()
  })

  it("clears the key when opting back in", async () => {
    window.localStorage.setItem(ANALYTICS_STORAGE_KEY, "off")
    renderForm()
    expect(radio("settings.analytics.off").checked).toBe(true)

    await userEvent.click(radio("settings.analytics.on"))
    await userEvent.click(screen.getByText("common.save"))
    expect(window.localStorage.getItem(ANALYTICS_STORAGE_KEY)).toBeNull()
  })
})
