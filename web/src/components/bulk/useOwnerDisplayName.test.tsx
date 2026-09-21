// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cleanup, renderHook } from "@testing-library/react"

import { UserPreferencesProvider } from "@/context/userPreferences/UserPreferencesProvider"
import { USER_PREFERENCE_SPECS } from "@/lib/userPreferences"
import type { Student } from "@/types/classroom"

import { useOwnerDisplayName } from "./fanOut"

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

beforeEach(installLocalStorage)
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const roster: Student[] = [
  {
    username: "ann",
    first_name: "Ann",
    last_name: "Lee",
    email: "",
    section: "",
    github_id: "",
    role: "",
  },
]

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <UserPreferencesProvider>{children}</UserPreferencesProvider>
)

describe("useOwnerDisplayName", () => {
  it("uses the roster name when known and falls back to the login", () => {
    const { result } = renderHook(() => useOwnerDisplayName(roster), {
      wrapper,
    })
    expect(result.current("ann")).toBe("Ann Lee")
    expect(result.current("zed")).toBe("zed")
  })

  it("follows the user's name order preference", () => {
    window.localStorage.setItem(
      USER_PREFERENCE_SPECS.nameOrder.storageKey,
      "last-first",
    )
    const { result } = renderHook(() => useOwnerDisplayName(roster), {
      wrapper,
    })
    expect(result.current("ann")).toBe("Lee Ann")
  })
})
