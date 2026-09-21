// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_USER_PREFERENCES,
  USER_PREFERENCE_SPECS,
  persistUserPreference,
  preferenceKeyForStorageKey,
  readUserPreference,
  readUserPreferences,
} from "./userPreferences"
import { ANALYTICS_STORAGE_KEY } from "@/types/preferences"

// happy-dom doesn't back window.localStorage here, so install a minimal
// in-memory store (same shape the hiddenOrgsStore / useTheme tests use).
function installLocalStorage() {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
  Object.defineProperty(window, "localStorage", {
    value: localStorage,
    configurable: true,
  })
}

const NAME_ORDER_KEY = USER_PREFERENCE_SPECS.nameOrder.storageKey

beforeEach(() => {
  installLocalStorage()
})

afterEach(() => {
  window.localStorage.clear()
})

describe("userPreferences", () => {
  it("resolves to the defaults when nothing is stored", () => {
    expect(readUserPreferences()).toEqual(DEFAULT_USER_PREFERENCES)
    expect(readUserPreference("nameOrder")).toBe("first-last")
  })

  it("round-trips a non-default choice", () => {
    persistUserPreference("nameOrder", "last-first")
    expect(window.localStorage.getItem(NAME_ORDER_KEY)).toBe("last-first")
    expect(readUserPreference("nameOrder")).toBe("last-first")
  })

  it("stores the default as an absent key", () => {
    persistUserPreference("nameOrder", "last-first")
    persistUserPreference("nameOrder", "first-last")
    expect(window.localStorage.getItem(NAME_ORDER_KEY)).toBeNull()
    expect(readUserPreference("nameOrder")).toBe("first-last")
  })

  it("falls back to the default for a value this build doesn't know", () => {
    window.localStorage.setItem(NAME_ORDER_KEY, "middle-first")
    expect(readUserPreference("nameOrder")).toBe("first-last")
  })

  it("maps a storage key back to its preference", () => {
    expect(preferenceKeyForStorageKey(NAME_ORDER_KEY)).toBe("nameOrder")
    expect(preferenceKeyForStorageKey("classroom50:theme")).toBeNull()
    expect(preferenceKeyForStorageKey(null)).toBeNull()
  })

  it("keeps every storage key in the classroom50 namespace and unique", () => {
    const keys = Object.values(USER_PREFERENCE_SPECS).map((s) => s.storageKey)
    expect(keys.every((k) => k.startsWith("classroom50:"))).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
  })

  // The analytics loader injected into index.html (vite.config.ts) reads this
  // key before React boots and treats exactly the literal "off" as an opt-out,
  // so the registry must never store the default and must store "off" as-is.
  it("stores the analytics opt-out as the literal 'off' and nothing else", () => {
    expect(readUserPreference("analytics")).toBe("on")
    expect(window.localStorage.getItem(ANALYTICS_STORAGE_KEY)).toBeNull()

    persistUserPreference("analytics", "off")
    expect(window.localStorage.getItem(ANALYTICS_STORAGE_KEY)).toBe("off")

    persistUserPreference("analytics", "on")
    expect(window.localStorage.getItem(ANALYTICS_STORAGE_KEY)).toBeNull()
  })
})
