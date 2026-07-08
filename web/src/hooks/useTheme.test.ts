// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import {
  THEME_STORAGE_KEY,
  resolveInitialTheme,
  useTheme,
  type Theme,
} from "./useTheme"

// The anti-flash inline script in index.html hand-mirrors resolveInitialTheme
// (same storage key + theme names) so the pre-mount paint matches what React
// resolves. Nothing else binds them and the drift symptom (a wrong-theme flash)
// is nearly invisible in review — so guard the contract here, like the repo's
// other hand-mirrored-contract drift tests (e.g. skeleton.test.ts).
describe("theme anti-flash contract (index.html <-> useTheme)", () => {
  // Resolve from the vitest cwd (the web package root) rather than
  // import.meta.url: this suite runs under happy-dom, where import.meta.url is
  // not a file: URL and fileURLToPath would throw.
  const indexHtml = readFileSync(path.join(process.cwd(), "index.html"), "utf8")
  const THEMES: Theme[] = ["sumi", "sumi-dark"]

  it("index.html references the same storage key", () => {
    expect(indexHtml).toContain(THEME_STORAGE_KEY)
  })

  it("index.html references every registered theme name", () => {
    for (const theme of THEMES) {
      expect(indexHtml, `index.html missing theme name: ${theme}`).toContain(
        `"${theme}"`,
      )
    }
  })
})

// Drive a `prefers-color-scheme: dark` result plus a captured change listener so
// tests can flip the OS preference at runtime. matchMedia isn't implemented in
// happy-dom, so we install a minimal stub.
function stubMatchMedia(initialDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  let matches = initialDark
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
  })) as unknown as typeof window.matchMedia
  return {
    listenerCount: () => listeners.size,
    emit(dark: boolean) {
      matches = dark
      for (const cb of listeners) cb({ matches: dark } as MediaQueryListEvent)
    },
  }
}

function getTheme() {
  return document.documentElement.getAttribute("data-theme")
}

// happy-dom (v15) doesn't back window.localStorage here, so install a minimal
// in-memory store — the same shape the i18n customLocale tests use.
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

describe("useTheme", () => {
  beforeEach(() => {
    installLocalStorage()
    document.documentElement.removeAttribute("data-theme")
    // Default: no View Transitions API (exercises the instant fallback); a
    // specific test opts into the animated branch.
    delete (document as { startViewTransition?: unknown }).startViewTransition
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as { matchMedia?: unknown }).matchMedia
  })

  describe("resolveInitialTheme", () => {
    it("prefers an explicit stored choice over the OS preference", () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "sumi-dark")
      stubMatchMedia(false)
      expect(resolveInitialTheme()).toBe("sumi-dark")
    })

    it("falls back to the OS preference when nothing is stored", () => {
      stubMatchMedia(true)
      expect(resolveInitialTheme()).toBe("sumi-dark")
      stubMatchMedia(false)
      expect(resolveInitialTheme()).toBe("sumi")
    })

    it("ignores a corrupt stored value and falls back to the OS", () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "neon")
      stubMatchMedia(true)
      expect(resolveInitialTheme()).toBe("sumi-dark")
    })
  })

  it("applies the initial theme to <html> on mount", () => {
    stubMatchMedia(false)
    renderHook(() => useTheme())
    expect(getTheme()).toBe("sumi")
  })

  it("does not animate the first apply but cross-fades a later user toggle", () => {
    stubMatchMedia(false)
    const startViewTransition = vi.fn((cb: () => void) => cb())
    ;(
      document as { startViewTransition?: (cb: () => void) => void }
    ).startViewTransition = startViewTransition

    const { result } = renderHook(() => useTheme())
    // First apply re-asserts the anti-flash paint — must not go through the
    // View Transition.
    expect(startViewTransition).not.toHaveBeenCalled()
    expect(getTheme()).toBe("sumi")

    act(() => result.current.toggleTheme())
    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(getTheme()).toBe("sumi-dark")
  })

  it("applies the theme via the fallback when startViewTransition is absent", () => {
    stubMatchMedia(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setTheme("sumi-dark"))
    expect(getTheme()).toBe("sumi-dark")
  })

  it("persists an explicit choice to localStorage", () => {
    stubMatchMedia(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setTheme("sumi-dark"))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("sumi-dark")
    expect(result.current.theme).toBe("sumi-dark")
    expect(result.current.isDark).toBe(true)
  })

  it("follows OS changes only while no explicit choice is stored", () => {
    const mql = stubMatchMedia(false)
    const { result } = renderHook(() => useTheme())

    act(() => mql.emit(true))
    expect(result.current.theme).toBe("sumi-dark")

    // Once the user picks explicitly, later OS changes are ignored.
    act(() => result.current.setTheme("sumi"))
    act(() => mql.emit(true))
    expect(result.current.theme).toBe("sumi")
  })

  it("does NOT animate an OS-driven change (only user toggles cross-fade)", () => {
    const mql = stubMatchMedia(false)
    const startViewTransition = vi.fn((cb: () => void) => cb())
    ;(
      document as { startViewTransition?: (cb: () => void) => void }
    ).startViewTransition = startViewTransition

    renderHook(() => useTheme())
    act(() => mql.emit(true))
    expect(startViewTransition).not.toHaveBeenCalled()
    expect(getTheme()).toBe("sumi-dark")
  })

  it("follows a cross-tab storage write for a valid value and ignores others", () => {
    stubMatchMedia(false)
    const { result } = renderHook(() => useTheme())

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: THEME_STORAGE_KEY,
          newValue: "sumi-dark",
        }),
      )
    })
    expect(result.current.theme).toBe("sumi-dark")

    // A write to an unrelated key, or a corrupt value, is ignored.
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "other", newValue: "sumi" }),
      )
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: THEME_STORAGE_KEY,
          newValue: "neon",
        }),
      )
    })
    expect(result.current.theme).toBe("sumi-dark")
  })

  it("removes the OS and storage listeners on unmount", () => {
    const mql = stubMatchMedia(false)
    const removeStorage = vi.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() => useTheme())
    expect(mql.listenerCount()).toBe(1)

    unmount()
    expect(mql.listenerCount()).toBe(0)
    expect(removeStorage).toHaveBeenCalledWith("storage", expect.any(Function))
  })
})
