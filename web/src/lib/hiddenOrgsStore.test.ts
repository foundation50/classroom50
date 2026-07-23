// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  HIDDEN_ORGS_STORAGE_KEY,
  persistHiddenOrgs,
  readHiddenOrgs,
} from "./hiddenOrgsStore"

// happy-dom (v15) doesn't back window.localStorage here, so install a minimal
// in-memory store — the same shape the useTheme / unresolvedStore tests use.
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

beforeEach(() => {
  installLocalStorage()
})

afterEach(() => {
  window.localStorage.clear()
})

describe("hiddenOrgsStore", () => {
  it("round-trips a set of logins through localStorage", () => {
    persistHiddenOrgs(new Set(["acme", "globex"]))
    expect(readHiddenOrgs()).toEqual(new Set(["acme", "globex"]))
  })

  it("returns an empty set when nothing is stored", () => {
    expect(readHiddenOrgs()).toEqual(new Set())
  })

  it("returns an empty set for corrupt JSON without throwing", () => {
    window.localStorage.setItem(HIDDEN_ORGS_STORAGE_KEY, "{not json")
    expect(readHiddenOrgs()).toEqual(new Set())
  })

  it("ignores non-string entries in a stored array", () => {
    window.localStorage.setItem(
      HIDDEN_ORGS_STORAGE_KEY,
      JSON.stringify(["acme", 42, null]),
    )
    expect(readHiddenOrgs()).toEqual(new Set(["acme"]))
  })

  it("persists an empty set as an empty array", () => {
    persistHiddenOrgs(new Set())
    expect(window.localStorage.getItem(HIDDEN_ORGS_STORAGE_KEY)).toBe("[]")
    expect(readHiddenOrgs()).toEqual(new Set())
  })
})
