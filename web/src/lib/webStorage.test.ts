// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"

import { localStorageOrNull, sessionStorageOrNull } from "./webStorage"

const restores: Array<() => void> = []

afterEach(() => {
  while (restores.length > 0) restores.pop()?.()
  vi.unstubAllGlobals()
})

// Swap a window property and register its undo, so a throwing accessor can't
// leak into a sibling test.
function redefine(
  name: "localStorage" | "sessionStorage",
  descriptor: PropertyDescriptor,
) {
  const original = Object.getOwnPropertyDescriptor(window, name)
  Object.defineProperty(window, name, { ...descriptor, configurable: true })
  restores.push(() => {
    if (original) Object.defineProperty(window, name, original)
    else delete (window as unknown as Record<string, unknown>)[name]
  })
}

// happy-dom doesn't back window.localStorage here, so install a minimal
// in-memory store — the same shape the unresolvedStore/useTheme tests use.
function installStore(name: "localStorage" | "sessionStorage"): Storage {
  const map = new Map<string, string>()
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
  redefine(name, { value: storage })
  return storage
}

// The helper exists because a *property read* can raise, not just return
// undefined — a getter is the only way to reproduce that.
function stubAccessor(
  name: "localStorage" | "sessionStorage",
  get: () => Storage,
) {
  redefine(name, { get })
}

describe("localStorageOrNull", () => {
  it("returns the store when it is usable", () => {
    const storage = installStore("localStorage")
    expect(localStorageOrNull()).toBe(storage)
  })

  it("returns null when the accessor throws (sandboxed iframe, blocked cookies)", () => {
    stubAccessor("localStorage", () => {
      throw new DOMException("denied", "SecurityError")
    })
    expect(localStorageOrNull()).toBeNull()
  })

  it("returns null when the API is absent", () => {
    stubAccessor("localStorage", () => undefined as unknown as Storage)
    expect(localStorageOrNull()).toBeNull()
  })

  it("returns null when there is no window at all", () => {
    vi.stubGlobal("window", undefined)
    expect(localStorageOrNull()).toBeNull()
  })
})

describe("sessionStorageOrNull", () => {
  it("returns the store when it is usable", () => {
    const storage = installStore("sessionStorage")
    expect(sessionStorageOrNull()).toBe(storage)
  })

  it("returns null when the accessor throws", () => {
    stubAccessor("sessionStorage", () => {
      throw new DOMException("denied", "SecurityError")
    })
    expect(sessionStorageOrNull()).toBeNull()
  })
})
