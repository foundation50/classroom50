// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { browserDeclinesTracking, readConsent, writeConsent } from "./consent"
import {
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  LEGACY_ANALYTICS_STORAGE_KEY,
} from "@/types/consent"

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
    const written = writeConsent({ analytics: true })
    expect(written.v).toBe(CONSENT_VERSION)
    expect(Date.parse(written.at)).not.toBeNaN()
    expect(readConsent()).toEqual(written)
  })

  it("treats an older version or a corrupt value as undecided", () => {
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ v: 0, at: "t", analytics: true }),
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
    expect(readConsent()).toMatchObject({ analytics: false })

    writeConsent({ analytics: true })
    expect(window.localStorage.getItem(LEGACY_ANALYTICS_STORAGE_KEY)).toBeNull()
    expect(readConsent()).toMatchObject({ analytics: true })
  })

  it("ignores a legacy value other than off", () => {
    window.localStorage.setItem(LEGACY_ANALYTICS_STORAGE_KEY, "on")
    expect(readConsent()).toBeNull()
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
