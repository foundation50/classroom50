// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  LEGACY_ANALYTICS_STORAGE_KEY,
} from "@/types/consent"
import { ConsentProvider, useConsent } from "./ConsentProvider"

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

const storageEvent = (key: string | null) =>
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key }))
  })

beforeEach(() => {
  installLocalStorage()
  window.dataLayer = []
  // The built page injects this runtime; without it there is nothing to ask.
  window.__classroom50Analytics = { enable: () => {}, started: () => false }
})
afterEach(() => {
  window.localStorage.clear()
  delete window.__classroom50Analytics
})

// Another tab's decision arrives through the `storage` event; this provider
// must follow it, including a Reset there (record removed), which is a
// withdrawal here.
describe("ConsentProvider across tabs", () => {
  it("starts vendors granted in another tab and stops Google when withdrawn there", () => {
    const enable = vi.fn()
    let googleStarted = false
    window.__classroom50Analytics = {
      enable: (categories) => {
        enable(categories)
        if (categories.includes("google")) googleStarted = true
      },
      started: (category) => category === "google" && googleStarted,
    }
    const { result } = renderHook(() => useConsent(), {
      wrapper: ConsentProvider,
    })
    expect(result.current.needsDecision).toBe(true)

    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({
        v: CONSENT_VERSION,
        at: "t",
        cloudflare: true,
        google: true,
      }),
    )
    storageEvent(CONSENT_STORAGE_KEY)
    expect(result.current.record).toMatchObject({ google: true })
    // Only real categories reach the runtime, never the record's v/at fields.
    expect(enable).toHaveBeenCalledWith(["cloudflare", "google"])

    window.localStorage.removeItem(CONSENT_STORAGE_KEY)
    storageEvent(CONSENT_STORAGE_KEY)
    expect(result.current.record).toBeNull()
    expect(result.current.needsDecision).toBe(true)
    expect(Array.from(window.dataLayer![0] as IArguments)).toEqual([
      "consent",
      "update",
      { analytics_storage: "denied" },
    ])
  })

  it("follows a Reset in another tab when this tab's denial was the legacy opt-out", () => {
    window.localStorage.setItem(LEGACY_ANALYTICS_STORAGE_KEY, "off")
    const { result } = renderHook(() => useConsent(), {
      wrapper: ConsentProvider,
    })
    expect(result.current.needsDecision).toBe(false)

    window.localStorage.removeItem(LEGACY_ANALYTICS_STORAGE_KEY)
    storageEvent(LEGACY_ANALYTICS_STORAGE_KEY)
    expect(result.current.record).toBeNull()
    expect(result.current.needsDecision).toBe(true)
  })

  it("ignores storage events for unrelated keys", () => {
    const { result } = renderHook(() => useConsent(), {
      wrapper: ConsentProvider,
    })
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({
        v: CONSENT_VERSION,
        at: "t",
        cloudflare: true,
        google: true,
      }),
    )
    storageEvent("classroom50:theme")
    expect(result.current.record).toBeNull()
  })
})

// A production build with no vendor injects no runtime, so there is nothing to
// decide; only the dev server injects one without a vendor.
describe("ConsentProvider without the analytics runtime", () => {
  it("does not ask", () => {
    delete window.__classroom50Analytics
    const { result } = renderHook(() => useConsent(), {
      wrapper: ConsentProvider,
    })
    expect(result.current.record).toBeNull()
    expect(result.current.needsDecision).toBe(false)
  })
})
