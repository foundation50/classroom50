// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  browserDeclinesTracking,
  clearConsent,
  readConsent,
  writeConsent,
} from "./consent"
import {
  ANALYTICS_RUNTIME_GLOBAL,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  LEGACY_ANALYTICS_STORAGE_KEY,
  OPTIONAL_CONSENT_CATEGORIES,
  type OptionalConsentCategory,
} from "@/types/consent"
import { analyticsPlugin } from "../../vite/analytics"

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

beforeEach(installLocalStorage)
afterEach(() => window.localStorage.clear())

describe("consent storage", () => {
  it("is undecided when nothing is stored", () => {
    expect(readConsent()).toBeNull()
  })

  it("round-trips a decision with the current version and a timestamp", () => {
    const written = writeConsent({ cloudflare: true, google: false })
    expect(written.v).toBe(CONSENT_VERSION)
    expect(Date.parse(written.at)).not.toBeNaN()
    expect(readConsent()).toEqual(written)
  })

  it("treats an older version or a corrupt value as undecided", () => {
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: 0, at: "t", cloudflare: true, google: true }),
    )
    expect(readConsent()).toBeNull()
    window.localStorage.setItem(CONSENT_STORAGE_KEY, "{not json")
    expect(readConsent()).toBeNull()
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: CONSENT_VERSION, at: "t" }),
    )
    expect(readConsent()).toBeNull()
  })

  it("honors the pre-consent opt-out as a denial and retires it on the next decision", () => {
    window.localStorage.setItem(LEGACY_ANALYTICS_STORAGE_KEY, "off")
    expect(readConsent()).toMatchObject({ cloudflare: false, google: false })

    writeConsent({ cloudflare: true, google: true })
    expect(window.localStorage.getItem(LEGACY_ANALYTICS_STORAGE_KEY)).toBeNull()
    expect(readConsent()).toMatchObject({ cloudflare: true, google: true })
  })

  it("ignores a legacy value other than off", () => {
    window.localStorage.setItem(LEGACY_ANALYTICS_STORAGE_KEY, "on")
    expect(readConsent()).toBeNull()
  })

  it("stamps a decision made from a stored record with a fresh timestamp", () => {
    const first = writeConsent({ cloudflare: true, google: false })
    const stored = {
      ...readConsent()!,
      at: "2000-01-01T00:00:00.000Z",
      v: 0 as typeof CONSENT_VERSION,
    }
    const second = writeConsent(stored)
    expect(second.v).toBe(CONSENT_VERSION)
    expect(second.at).not.toBe("2000-01-01T00:00:00.000Z")
    expect(second).toMatchObject({ cloudflare: true, google: false })
    expect(first.cloudflare).toBe(second.cloudflare)
  })

  it("clearConsent forgets the decision and the legacy opt-out", () => {
    writeConsent({ cloudflare: true, google: true })
    window.localStorage.setItem(LEGACY_ANALYTICS_STORAGE_KEY, "off")
    clearConsent()
    expect(readConsent()).toBeNull()
    expect(window.localStorage.getItem(LEGACY_ANALYTICS_STORAGE_KEY)).toBeNull()
  })
})

describe("browserDeclinesTracking", () => {
  it("is true for Global Privacy Control or Do Not Track only", () => {
    expect(browserDeclinesTracking({ globalPrivacyControl: true })).toBe(true)
    expect(browserDeclinesTracking({ doNotTrack: "1" })).toBe(true)
    expect(browserDeclinesTracking({ doNotTrack: "0" })).toBe(false)
    expect(browserDeclinesTracking({})).toBe(false)
  })
})

// The consent runtime that web/vite/analytics.ts injects parses the stored
// record before React boots, with its own copy of the parse. Feed both parsers
// every shape and require the same answer, so they can't drift apart.
describe("readConsent and the injected runtime", () => {
  // Runs the injected runtime snippet against this test's storage and reports
  // which optional categories it would start.
  function runtimeStarts(): OptionalConsentCategory[] {
    const html = (
      analyticsPlugin({}, true).transformIndexHtml as (html: string) => string
    )("<html><head>\n</head><body>\n</body></html>")
    const code = /<script>([\s\S]*?)<\/script>/.exec(html)![1]
    const win: Record<string, unknown> = {}
    new Function("window", "navigator", "localStorage", code)(
      win,
      {},
      window.localStorage,
    )
    const runtime = win[ANALYTICS_RUNTIME_GLOBAL] as {
      register: (category: string, fn: () => void) => void
      started: (category: string) => boolean
    }
    for (const category of OPTIONAL_CONSENT_CATEGORIES) {
      runtime.register(category, () => {})
    }
    return OPTIONAL_CONSENT_CATEGORIES.filter((c) => runtime.started(c))
  }
  const record = (value: unknown) =>
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(value))

  it.each<[string, () => void]>([
    ["nothing stored", () => {}],
    [
      "both granted",
      () =>
        record({ v: CONSENT_VERSION, at: "t", cloudflare: true, google: true }),
    ],
    [
      "one granted",
      () =>
        record({
          v: CONSENT_VERSION,
          at: "t",
          cloudflare: false,
          google: true,
        }),
    ],
    [
      "both denied",
      () =>
        record({
          v: CONSENT_VERSION,
          at: "t",
          cloudflare: false,
          google: false,
        }),
    ],
    [
      "older version",
      () => record({ v: 0, at: "t", cloudflare: true, google: true }),
    ],
    [
      "missing category",
      () => record({ v: CONSENT_VERSION, at: "t", cloudflare: true }),
    ],
    [
      "missing timestamp",
      () => record({ v: CONSENT_VERSION, cloudflare: true, google: true }),
    ],
    [
      "category not boolean",
      () =>
        record({
          v: CONSENT_VERSION,
          at: "t",
          cloudflare: "yes",
          google: true,
        }),
    ],
    [
      "corrupt JSON",
      () => window.localStorage.setItem(CONSENT_STORAGE_KEY, "{not json"),
    ],
    [
      "legacy off",
      () => window.localStorage.setItem(LEGACY_ANALYTICS_STORAGE_KEY, "off"),
    ],
    [
      "legacy on",
      () => window.localStorage.setItem(LEGACY_ANALYTICS_STORAGE_KEY, "on"),
    ],
    [
      "storage throws",
      () =>
        Object.defineProperty(window, "localStorage", {
          value: {
            getItem() {
              throw new Error("blocked")
            },
            clear() {},
          },
          configurable: true,
        }),
    ],
  ])("agree on %s", (_name, arrange) => {
    arrange()
    const app = readConsent()
    const expected = OPTIONAL_CONSENT_CATEGORIES.filter(
      (c) => app?.[c] === true,
    )
    expect(runtimeStarts()).toEqual(expected)
  })
})
