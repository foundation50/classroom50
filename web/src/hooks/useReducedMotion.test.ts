// @vitest-environment happy-dom
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import {
  MOTION_STORAGE_KEY,
  motionReduced,
  resolveInitialMotionPref,
  storedMotionPref,
  useReducedMotion,
  type MotionPref,
} from "./useReducedMotion"

// The anti-flash inline script in index.html hand-mirrors the motion resolver
// (same storage key + the three pref values + the OS media query), so the
// pre-mount paint matches what React resolves. Guard the contract here like the
// theme anti-flash drift test — the drift symptom (a first-paint animation for a
// motion-off user) is nearly invisible in review.
describe("motion anti-flash contract (index.html <-> useReducedMotion)", () => {
  const indexHtml = readFileSync(path.join(process.cwd(), "index.html"), "utf8")

  it("index.html references the same storage key", () => {
    expect(indexHtml).toContain(MOTION_STORAGE_KEY)
  })

  it("index.html branches on the same pref values and OS query", () => {
    expect(indexHtml).toContain('=== "off"')
    expect(indexHtml).toContain('=== "on"')
    expect(indexHtml).toContain("(prefers-reduced-motion: reduce)")
    expect(indexHtml).toContain("data-reduce-motion")
  })
})

describe("motionReduced", () => {
  it("off always reduces; on never reduces; system follows the OS", () => {
    expect(motionReduced("off", false)).toBe(true)
    expect(motionReduced("off", true)).toBe(true)
    expect(motionReduced("on", true)).toBe(false)
    expect(motionReduced("on", false)).toBe(false)
    expect(motionReduced("system", true)).toBe(true)
    expect(motionReduced("system", false)).toBe(false)
  })
})

// Drive a `prefers-reduced-motion: reduce` result plus a captured change
// listener so tests can flip the OS preference at runtime. matchMedia isn't
// implemented in happy-dom, so install a minimal stub.
function stubMatchMedia(initialReduced: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  let matches = initialReduced
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
    emit(reduced: boolean) {
      matches = reduced
      for (const cb of listeners)
        cb({ matches: reduced } as MediaQueryListEvent)
    },
  }
}

function attr() {
  return document.documentElement.getAttribute("data-reduce-motion")
}

// happy-dom (v15) doesn't back window.localStorage here, so install a minimal
// in-memory store — the same shape the useTheme tests use.
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

describe("useReducedMotion", () => {
  beforeEach(() => {
    installLocalStorage()
    document.documentElement.removeAttribute("data-reduce-motion")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as { matchMedia?: unknown }).matchMedia
  })

  describe("resolveInitialMotionPref / storedMotionPref", () => {
    it("prefers an explicit stored choice", () => {
      window.localStorage.setItem(MOTION_STORAGE_KEY, "off")
      expect(resolveInitialMotionPref()).toBe("off")
      expect(storedMotionPref()).toBe("off")
    })

    it("defaults to system when unset", () => {
      expect(resolveInitialMotionPref()).toBe("system")
      expect(storedMotionPref()).toBeNull()
    })

    it("ignores a corrupt stored value", () => {
      window.localStorage.setItem(MOTION_STORAGE_KEY, "sometimes")
      expect(resolveInitialMotionPref()).toBe("system")
      expect(storedMotionPref()).toBeNull()
    })
  })

  it("sets the <html> attribute when system resolves to a reducing OS", () => {
    stubMatchMedia(true)
    renderHook(() => useReducedMotion())
    expect(attr()).toBe("true")
  })

  it("leaves the attribute off when system resolves to a non-reducing OS", () => {
    stubMatchMedia(false)
    const { result } = renderHook(() => useReducedMotion())
    expect(attr()).toBeNull()
    expect(result.current.reduced).toBe(false)
  })

  it("off forces the attribute on even when the OS does not reduce", () => {
    stubMatchMedia(false)
    const { result } = renderHook(() => useReducedMotion())
    act(() => result.current.setPref("off"))
    expect(attr()).toBe("true")
    expect(result.current.reduced).toBe(true)
    expect(window.localStorage.getItem(MOTION_STORAGE_KEY)).toBe("off")
  })

  it("on forces the attribute off even when the OS reduces", () => {
    stubMatchMedia(true)
    const { result } = renderHook(() => useReducedMotion())
    expect(attr()).toBe("true")
    act(() => result.current.setPref("on"))
    expect(attr()).toBeNull()
    expect(result.current.reduced).toBe(false)
    expect(window.localStorage.getItem(MOTION_STORAGE_KEY)).toBe("on")
  })

  it("clears the key (not a sentinel) when returning to system", () => {
    stubMatchMedia(false)
    const { result } = renderHook(() => useReducedMotion())
    act(() => result.current.setPref("off"))
    expect(window.localStorage.getItem(MOTION_STORAGE_KEY)).toBe("off")
    act(() => result.current.setPref("system"))
    expect(window.localStorage.getItem(MOTION_STORAGE_KEY)).toBeNull()
    expect(result.current.pref).toBe("system")
  })

  it("tracks OS changes while on system, and ignores them once overridden", () => {
    const mql = stubMatchMedia(false)
    const { result } = renderHook(() => useReducedMotion())

    act(() => mql.emit(true))
    expect(result.current.reduced).toBe(true)
    expect(attr()).toBe("true")

    // Force "on": later OS reduce signals no longer reduce.
    act(() => result.current.setPref("on"))
    act(() => mql.emit(true))
    expect(result.current.reduced).toBe(false)
    expect(attr()).toBeNull()
  })

  it("follows a cross-tab write and resets to system on a clear/corrupt value", () => {
    stubMatchMedia(false)
    const { result } = renderHook(() => useReducedMotion())

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: MOTION_STORAGE_KEY,
          newValue: "off",
        }),
      )
    })
    expect(result.current.pref).toBe("off")

    // A clear (null) or corrupt value resets to the default.
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: MOTION_STORAGE_KEY,
          newValue: null,
        }),
      )
    })
    expect(result.current.pref).toBe("system")

    // An unrelated key is ignored.
    act(() => result.current.setPref("off"))
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "other", newValue: "system" }),
      )
    })
    expect(result.current.pref).toBe("off")
  })

  it("removes the OS and storage listeners on unmount", () => {
    const mql = stubMatchMedia(false)
    const removeStorage = vi.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() => useReducedMotion())
    expect(mql.listenerCount()).toBe(1)

    unmount()
    expect(mql.listenerCount()).toBe(0)
    expect(removeStorage).toHaveBeenCalledWith("storage", expect.any(Function))
  })

  it("exposes the tri-state pref value", () => {
    stubMatchMedia(false)
    const prefs: MotionPref[] = ["system", "on", "off"]
    const { result } = renderHook(() => useReducedMotion())
    for (const p of prefs) {
      act(() => result.current.setPref(p))
      expect(result.current.pref).toBe(p)
    }
  })
})
