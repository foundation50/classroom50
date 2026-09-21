// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import {
  UserPreferencesProvider,
  useUserPreference,
  useUserPreferences,
} from "./UserPreferencesProvider"
import { USER_PREFERENCE_SPECS } from "@/lib/userPreferences"

// happy-dom doesn't back window.localStorage here, so install a minimal
// in-memory store (same shape the HiddenOrgsProvider test uses).
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

const NAME_ORDER_KEY = USER_PREFERENCE_SPECS.nameOrder.storageKey

beforeEach(installLocalStorage)
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <UserPreferencesProvider>{children}</UserPreferencesProvider>
)

describe("UserPreferencesProvider", () => {
  it("starts from the defaults and persists a change", () => {
    const { result } = renderHook(useUserPreferences, { wrapper })
    expect(result.current.preferences.nameOrder).toBe("first-last")
    act(() => result.current.setPreference("nameOrder", "last-first"))
    expect(result.current.preferences.nameOrder).toBe("last-first")
    expect(window.localStorage.getItem(NAME_ORDER_KEY)).toBe("last-first")
  })

  it("seeds initial state from storage", () => {
    window.localStorage.setItem(NAME_ORDER_KEY, "last-first")
    const { result } = renderHook(() => useUserPreference("nameOrder"), {
      wrapper,
    })
    expect(result.current).toBe("last-first")
  })

  it("follows a change made in another tab, including a clear", () => {
    const { result } = renderHook(() => useUserPreference("nameOrder"), {
      wrapper,
    })
    act(() => {
      window.localStorage.setItem(NAME_ORDER_KEY, "last-first")
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: NAME_ORDER_KEY,
          newValue: "last-first",
        }),
      )
    })
    expect(result.current).toBe("last-first")

    act(() => {
      window.localStorage.removeItem(NAME_ORDER_KEY)
      window.dispatchEvent(
        new StorageEvent("storage", { key: NAME_ORDER_KEY, newValue: null }),
      )
    })
    expect(result.current).toBe("first-last")
  })

  it("ignores storage events for unrelated keys", () => {
    const { result } = renderHook(() => useUserPreference("nameOrder"), {
      wrapper,
    })
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "classroom50:theme",
          newValue: "sumi-dark",
        }),
      )
    })
    expect(result.current).toBe("first-last")
  })

  it("reads defaults without a provider", () => {
    const { result } = renderHook(() => useUserPreference("nameOrder"))
    expect(result.current).toBe("first-last")
  })
})
