// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ConsentProvider } from "@/context/consent/ConsentProvider"
import { CONSENT_STORAGE_KEY, CONSENT_VERSION } from "@/types/consent"
import { ConsentBanner } from "./ConsentBanner"
import { ConsentPreferencesForm } from "./ConsentPreferencesForm"

vi.mock("react-i18next", async (importActual) => {
  const actual = await importActual<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})
// The banner lives outside RouterProvider and navigates through the router
// instance; the test only needs the link to exist.
vi.mock("@/router", () => ({
  router: { navigate: vi.fn(() => Promise.resolve()) },
}))

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

// The consent runtime the built page injects (web/vite/analytics.ts); dev and
// test builds have none, so install a recording fake.
function installRuntime(started = false) {
  const enable = vi.fn()
  window.__classroom50Analytics = { enable, started: () => started }
  return enable
}

const stored = () =>
  JSON.parse(window.localStorage.getItem(CONSENT_STORAGE_KEY) ?? "null")

beforeEach(() => {
  installLocalStorage()
  Object.defineProperty(window.navigator, "globalPrivacyControl", {
    value: undefined,
    configurable: true,
  })
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  delete window.__classroom50Analytics
})

describe("ConsentBanner", () => {
  it("asks on a first visit and starts analytics only after Accept", async () => {
    const enable = installRuntime()
    render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    expect(
      screen.getByRole("region", { name: "consent.banner.aria" }),
    ).toBeTruthy()
    expect(enable).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText("consent.banner.accept"))
    expect(stored()).toMatchObject({ v: CONSENT_VERSION, analytics: true })
    expect(enable).toHaveBeenCalledWith(["analytics"])
  })

  it("records a rejection without starting anything", async () => {
    const enable = installRuntime()
    render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    await userEvent.click(screen.getByText("consent.banner.reject"))
    expect(stored()).toMatchObject({ analytics: false })
    expect(enable).not.toHaveBeenCalled()
  })

  it("stays hidden once a decision exists", () => {
    installRuntime()
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: CONSENT_VERSION, at: "t", analytics: false }),
    )
    render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    expect(screen.queryByRole("region")).toBeNull()
  })

  it("stays hidden when the browser sends Global Privacy Control", () => {
    installRuntime()
    Object.defineProperty(window.navigator, "globalPrivacyControl", {
      value: true,
      configurable: true,
    })
    render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    expect(screen.queryByRole("region")).toBeNull()
  })
})

describe("ConsentPreferencesForm", () => {
  it("starts from everything off for an undecided visitor and saves the draft", async () => {
    const enable = installRuntime()
    render(
      <ConsentProvider>
        <ConsentPreferencesForm idPrefix="t" />
      </ConsentProvider>,
    )
    const toggle = screen.getByLabelText(
      "consent.categories.analytics.label",
    ) as HTMLInputElement
    expect(toggle.checked).toBe(false)

    await userEvent.click(toggle)
    expect(stored()).toBeNull()

    await userEvent.click(screen.getByText("consent.savePreferences"))
    expect(stored()).toMatchObject({ analytics: true })
    expect(enable).toHaveBeenCalledWith(["analytics"])
  })

  it("withdrawing tells Google to stop storing and clears its cookies", async () => {
    installRuntime(true)
    window.dataLayer = []
    document.cookie = "_ga=GA1.1.x; path=/"
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: CONSENT_VERSION, at: "t", analytics: true }),
    )
    render(
      <ConsentProvider>
        <ConsentPreferencesForm idPrefix="t" />
      </ConsentProvider>,
    )
    await userEvent.click(screen.getByText("consent.rejectAll"))
    expect(stored()).toMatchObject({ analytics: false })
    expect(Array.from(window.dataLayer[0] as IArguments)).toEqual([
      "consent",
      "update",
      { analytics_storage: "denied" },
    ])
    expect(document.cookie).not.toContain("_ga=")
  })

  it("explains each category on demand", async () => {
    installRuntime()
    render(
      <ConsentProvider>
        <ConsentPreferencesForm idPrefix="t" />
      </ConsentProvider>,
    )
    expect(screen.getByText("consent.alwaysOn")).toBeTruthy()
    const [necessary] = screen.getAllByText("consent.whatThisIncludes")
    expect(necessary.getAttribute("aria-expanded")).toBe("false")
    await userEvent.click(necessary)
    expect(necessary.getAttribute("aria-expanded")).toBe("true")
    expect(
      screen.getByText("consent.categories.necessary.items.consent"),
    ).toBeTruthy()
  })
})
