// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HIDDEN_ORGS_STORAGE_KEY } from "@/lib/hiddenOrgsStore"
import { HiddenOrgsProvider } from "@/context/hiddenOrgs/HiddenOrgsProvider"

vi.mock("@/components/PageShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@/hooks/useDocumentTitle", () => ({ useDocumentTitle: () => {} }))
vi.mock("react-i18next", async (importActual) => {
  const actual = await importActual<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size
      },
    },
    configurable: true,
  })
}

import SettingsPage from "./SettingsPage"

const renderPage = () =>
  render(
    <HiddenOrgsProvider>
      <SettingsPage />
    </HiddenOrgsProvider>,
  )

beforeEach(installLocalStorage)
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe("SettingsPage hidden organizations", () => {
  it("shows the empty state when no orgs are hidden", () => {
    renderPage()
    expect(screen.getByText("settings.hiddenOrgs.empty")).toBeTruthy()
  })

  it("lists hidden org logins seeded from storage", () => {
    window.localStorage.setItem(
      HIDDEN_ORGS_STORAGE_KEY,
      JSON.stringify(["acme", "globex"]),
    )
    renderPage()
    expect(screen.getByText("acme")).toBeTruthy()
    expect(screen.getByText("globex")).toBeTruthy()
  })

  it("unhides an org when Unhide is clicked", async () => {
    window.localStorage.setItem(
      HIDDEN_ORGS_STORAGE_KEY,
      JSON.stringify(["acme"]),
    )
    renderPage()
    expect(screen.getByText("acme")).toBeTruthy()
    await userEvent.click(screen.getByText("settings.hiddenOrgs.unhide"))
    expect(screen.queryByText("acme")).toBeNull()
    expect(screen.getByText("settings.hiddenOrgs.empty")).toBeTruthy()
  })
})
