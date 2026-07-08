// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  clearUnresolved,
  mergeUnresolved,
  readUnresolved,
} from "./unresolvedStore"

// happy-dom (v15) doesn't back window.localStorage here, so install a minimal
// in-memory store — the same shape the useTheme / i18n tests use.
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

describe("unresolvedStore", () => {
  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it("returns empty sets when nothing is stored", () => {
    const rec = readUnresolved("acme")
    expect(rec.fields.size).toBe(0)
    expect(rec.concerns.size).toBe(0)
  })

  it("round-trips fields and concerns", () => {
    mergeUnresolved("acme", {
      fields: ["members_can_create_pages"],
      concerns: ["branchProtection"],
    })
    const rec = readUnresolved("acme")
    expect([...rec.fields]).toEqual(["members_can_create_pages"])
    expect([...rec.concerns]).toEqual(["branchProtection"])
  })

  it("unions on a second merge rather than replacing", () => {
    mergeUnresolved("acme", { concerns: ["branchProtection"] })
    mergeUnresolved("acme", { concerns: ["rulesets"] })
    const rec = readUnresolved("acme")
    expect(rec.concerns).toEqual(new Set(["branchProtection", "rulesets"]))
  })

  it("returns empty sets on corrupt JSON (never throws)", () => {
    window.localStorage.setItem("c50:audit:unresolved:v1:acme", "{not json")
    const rec = readUnresolved("acme")
    expect(rec.fields.size).toBe(0)
    expect(rec.concerns.size).toBe(0)
  })

  it("keeps orgs independent", () => {
    mergeUnresolved("acme", { concerns: ["rulesets"] })
    expect(readUnresolved("other").concerns.size).toBe(0)
    expect(readUnresolved("acme").concerns.has("rulesets")).toBe(true)
  })

  it("clearUnresolved removes the org's record", () => {
    mergeUnresolved("acme", { concerns: ["rulesets"] })
    clearUnresolved("acme")
    expect(readUnresolved("acme").concerns.size).toBe(0)
  })
})
