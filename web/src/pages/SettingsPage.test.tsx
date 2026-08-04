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
// LanguageSwitcher pulls in the full language/registry stack (useLanguage reads
// i18n.language, which this suite's react-i18next mock doesn't provide); it has
// its own tests, so stub it here to keep this suite focused on the page.
vi.mock("@/components/settings/LanguageSwitcher", () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}))
vi.mock("@/hooks/useDocumentTitle", () => ({ useDocumentTitle: () => {} }))
vi.mock("react-i18next", async (importActual) => {
  const actual = await importActual<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

// Router Link -> a plain anchor so the section renders without a RouterProvider.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({
      children,
      params,
      hash,
    }: {
      children: React.ReactNode
      params?: { org?: string }
      hash?: string
    }) => (
      <a href={`/${params?.org ?? ""}/settings${hash ? `#${hash}` : ""}`}>
        {children}
      </a>
    ),
    // The page calls useHashSectionHighlight, which reads router state; stub it
    // out here so the section renders without a RouterProvider.
    useRouterState: () => "",
    useNavigate: () => () => Promise.resolve(),
  }
})

// RouterButton -> a plain anchor too (it wraps createLink, which needs a
// RouterProvider we don't mount here). The Manage affordance is a RouterButton.
vi.mock("@/components/ui", async (importActual) => {
  const actual = await importActual<typeof import("@/components/ui")>()
  return {
    ...actual,
    RouterButton: ({
      children,
      params,
      hash,
    }: {
      children: React.ReactNode
      params?: { org?: string }
      hash?: string
    }) => (
      <a href={`/${params?.org ?? ""}/settings${hash ? `#${hash}` : ""}`}>
        {children}
      </a>
    ),
  }
})

type OrgSummary = {
  org: { login: string; id: number }
  membership: { role: "admin" | "member" }
  classroom50: { status: string }
}
const orgsData: { data: OrgSummary[]; isLoading: boolean } = {
  data: [],
  isLoading: false,
}
vi.mock("@/hooks/useGetOrgs", () => ({ default: () => orgsData }))

import type { OrgTokenHealthEntry } from "@/hooks/useOrgServiceTokenHealth"
const healthByOrg: Record<string, OrgTokenHealthEntry> = {}
vi.mock("@/hooks/useOrgServiceTokenHealth", async (importActual) => {
  const actual =
    await importActual<typeof import("@/hooks/useOrgServiceTokenHealth")>()
  return {
    ...actual,
    useOrgServiceTokenHealth: () => ({ byOrg: healthByOrg, anyLoading: false }),
  }
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
  orgsData.data = []
  orgsData.isLoading = false
  for (const k of Object.keys(healthByOrg)) delete healthByOrg[k]
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

describe("SettingsPage service tokens", () => {
  it("shows the empty state when no owned+ready orgs exist", () => {
    orgsData.data = [
      // a member (non-owner) org and a needs-setup org are both excluded
      {
        org: { login: "member-org", id: 1 },
        membership: { role: "member" },
        classroom50: { status: "ready" },
      },
      {
        org: { login: "setup-org", id: 2 },
        membership: { role: "admin" },
        classroom50: { status: "needs_setup" },
      },
    ]
    renderPage()
    expect(screen.getByText("settings.serviceTokens.empty")).toBeTruthy()
  })

  it("lists owned+ready orgs with their stored name and a Manage link", () => {
    orgsData.data = [
      {
        org: { login: "cs50", id: 42 },
        membership: { role: "admin" },
        classroom50: { status: "ready" },
      },
    ]
    healthByOrg["cs50"] = {
      org: "cs50",
      health: "expiringSoon",
      tokenName: "classroom50-token-42-ab12",
      expiresAt: "2026-10-01T00:00:00Z",
      loading: false,
    }
    renderPage()
    expect(screen.getByText("cs50")).toBeTruthy()
    expect(screen.getByText("classroom50-token-42-ab12")).toBeTruthy()
    const manage = screen.getByText("settings.serviceTokens.manage")
    expect(manage.closest("a")?.getAttribute("href")).toBe(
      "/cs50/settings#service-token",
    )
  })
})
