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
// The prompt lives outside RouterProvider and navigates through the router
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
function installRuntime(started: string[] = []) {
  const enable = vi.fn()
  window.__classroom50Analytics = {
    enable,
    started: (category) => started.includes(category),
  }
  return enable
}

// happy-dom doesn't implement <dialog> showModal/close; the prompt is a Modal,
// so stub them and read `open` to tell asked from not asked.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
    this.dispatchEvent(new Event("close"))
  }
})
const promptOpen = () =>
  screen.getByText("consent.banner.title").closest("dialog")!.open

const stored = () =>
  JSON.parse(window.localStorage.getItem(CONSENT_STORAGE_KEY) ?? "null")
const checkbox = (category: string) =>
  screen.getByLabelText(
    `consent.categories.${category}.label`,
  ) as HTMLInputElement
const decided = (choices: Record<string, boolean>) =>
  JSON.stringify({ v: CONSENT_VERSION, at: "t", ...choices })

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
  it("asks on a first visit with every optional category pre-selected", () => {
    installRuntime()
    render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    expect(promptOpen()).toBe(true)
    expect(checkbox("cloudflare").checked).toBe(true)
    expect(checkbox("google").checked).toBe(true)
    expect(
      screen.queryByLabelText("consent.categories.functional.label"),
    ).toBeNull()
    expect(screen.getByText("consent.alwaysOn", { exact: false })).toBeTruthy()
  })

  it("Accept saves what is selected and starts only those vendors", async () => {
    const enable = installRuntime()
    render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    await userEvent.click(checkbox("google"))
    expect(stored()).toBeNull()
    expect(enable).not.toHaveBeenCalled()

    await userEvent.click(screen.getByText("consent.banner.accept"))
    expect(stored()).toMatchObject({ cloudflare: true, google: false })
    expect(enable).toHaveBeenCalledWith(["cloudflare"])
    expect(promptOpen()).toBe(false)
  })

  it("Decline turns every optional category off and starts nothing", async () => {
    const enable = installRuntime()
    render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    await userEvent.click(screen.getByText("consent.banner.decline"))
    expect(stored()).toMatchObject({ cloudflare: false, google: false })
    expect(enable).not.toHaveBeenCalled()
    expect(promptOpen()).toBe(false)
  })

  it("stays closed once a decision exists or when the browser sends Global Privacy Control", () => {
    installRuntime()
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      decided({ cloudflare: false, google: false }),
    )
    const { unmount } = render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    expect(promptOpen()).toBe(false)
    unmount()
    window.localStorage.clear()

    Object.defineProperty(window.navigator, "globalPrivacyControl", {
      value: true,
      configurable: true,
    })
    render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    expect(promptOpen()).toBe(false)
  })
})

describe("ConsentBanner after Reset", () => {
  it("shows the defaults again, not the last unchecked state", async () => {
    installRuntime()
    render(
      <ConsentProvider>
        <ConsentBanner />
        <ConsentPreferencesForm idPrefix="t" />
      </ConsentProvider>,
    )
    // In the bar: uncheck Google, then decide.
    const barGoogle = document.getElementById(
      "consent-prompt-google",
    ) as HTMLInputElement
    await userEvent.click(barGoogle)
    expect(barGoogle.checked).toBe(false)
    await userEvent.click(screen.getByText("consent.banner.accept"))
    expect(promptOpen()).toBe(false)

    await userEvent.click(screen.getByText("consent.reset"))
    expect(promptOpen()).toBe(true)
    expect(
      (document.getElementById("consent-prompt-google") as HTMLInputElement)
        .checked,
    ).toBe(true)
    expect(
      (document.getElementById("consent-prompt-cloudflare") as HTMLInputElement)
        .checked,
    ).toBe(true)
  })
})

describe("ConsentBanner privacy notice", () => {
  it("expands the notice inside the prompt and collapses it again, without dismissing the prompt", async () => {
    installRuntime()
    render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    expect(screen.queryByText("privacy.data.heading")).toBeNull()

    await userEvent.click(screen.getByText("consent.banner.readNotice"))
    expect(screen.getByText("privacy.data.heading")).toBeTruthy()
    // The prompt's own controls are the choice, so the notice has no form.
    expect(screen.queryByText("privacy.choice.heading")).toBeNull()
    expect(screen.getByText("consent.banner.accept")).toBeTruthy()

    await userEvent.keyboard("{Escape}")
    expect(screen.queryByText("privacy.data.heading")).toBeNull()
    expect(promptOpen()).toBe(true)
  })

  it("explains the functional category with a tooltip", () => {
    installRuntime()
    render(
      <ConsentProvider>
        <ConsentBanner />
      </ConsentProvider>,
    )
    expect(
      screen.getByLabelText("consent.categories.functional.tooltip"),
    ).toBeTruthy()
  })
})

describe("ConsentPreferencesForm", () => {
  it("shows the same defaults as the prompt for an undecided visitor and saves the draft", async () => {
    const enable = installRuntime()
    render(
      <ConsentProvider>
        <ConsentPreferencesForm idPrefix="t" />
      </ConsentProvider>,
    )
    expect(checkbox("cloudflare").checked).toBe(true)
    expect(checkbox("google").checked).toBe(true)

    await userEvent.click(checkbox("cloudflare"))
    expect(stored()).toBeNull()

    await userEvent.click(screen.getByText("consent.savePreferences"))
    expect(stored()).toMatchObject({ cloudflare: false, google: true })
    expect(enable).toHaveBeenCalledWith(["google"])
  })

  it("reflects a saved decision, so Settings and the prompt agree", () => {
    installRuntime()
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      decided({ cloudflare: true, google: false }),
    )
    render(
      <ConsentProvider>
        <ConsentPreferencesForm idPrefix="t" />
      </ConsentProvider>,
    )
    expect(checkbox("cloudflare").checked).toBe(true)
    expect(checkbox("google").checked).toBe(false)
  })

  it("turning Google off tells it to stop storing and clears its cookies", async () => {
    installRuntime(["google"])
    window.dataLayer = []
    document.cookie = "_ga=GA1.1.x; path=/"
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      decided({ cloudflare: true, google: true }),
    )
    render(
      <ConsentProvider>
        <ConsentPreferencesForm idPrefix="t" />
      </ConsentProvider>,
    )
    await userEvent.click(screen.getByText("consent.declineAll"))
    expect(stored()).toMatchObject({ cloudflare: false, google: false })
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
    const [functional] = screen.getAllByText("consent.whatThisIncludes")
    expect(functional.getAttribute("aria-expanded")).toBe("false")
    await userEvent.click(functional)
    expect(functional.getAttribute("aria-expanded")).toBe("true")
    expect(
      screen.getByText("consent.categories.functional.items.consent"),
    ).toBeTruthy()
  })

  it("offers Reset only once a decision exists, and Reset forgets it and re-asks", async () => {
    installRuntime(["google"])
    window.dataLayer = []
    const { unmount } = render(
      <ConsentProvider>
        <ConsentPreferencesForm idPrefix="t" />
      </ConsentProvider>,
    )
    expect(screen.queryByText("consent.reset")).toBeNull()
    unmount()

    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      decided({ cloudflare: true, google: true }),
    )
    render(
      <ConsentProvider>
        <ConsentPreferencesForm idPrefix="t" />
        <ConsentBanner />
      </ConsentProvider>,
    )
    expect(promptOpen()).toBe(false)
    await userEvent.click(screen.getByText("consent.reset"))
    expect(stored()).toBeNull()
    expect(Array.from(window.dataLayer[0] as IArguments)).toEqual([
      "consent",
      "update",
      { analytics_storage: "denied" },
    ])
    expect(promptOpen()).toBe(true)
  })
})
