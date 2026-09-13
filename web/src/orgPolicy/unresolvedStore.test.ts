// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearUnresolved,
  forgetResolvedConcerns,
  mergeUnresolved,
  readUnresolved,
  reconcileUnresolvedConcerns,
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
    // Re-install: a test may have left a throwing accessor in place.
    installLocalStorage()
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

  it("forgetResolvedConcerns drops only the given concerns, keeping fields", () => {
    mergeUnresolved("acme", {
      fields: ["members_can_create_repositories"],
      concerns: ["branchProtection", "rulesets"],
    })
    forgetResolvedConcerns("acme", ["rulesets", "never-stored"])
    const rec = readUnresolved("acme")
    expect(rec.concerns).toEqual(new Set(["branchProtection"]))
    expect(rec.fields).toEqual(new Set(["members_can_create_repositories"]))
  })

  it("forgetResolvedConcerns does not write when nothing is left to forget", () => {
    mergeUnresolved("acme", { concerns: ["branchProtection"] })
    const setItem = vi.spyOn(window.localStorage, "setItem")
    forgetResolvedConcerns("acme", ["rulesets"])
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  // A sandboxed iframe or blocked cookies makes the getter throw, and the audit
  // pane would die on mount if any entry point propagated that.
  it("degrades to empty when the storage accessor throws", () => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("denied", "SecurityError")
      },
      configurable: true,
    })
    expect(readUnresolved("acme").concerns.size).toBe(0)
    expect(() =>
      mergeUnresolved("acme", { concerns: ["rulesets"] }),
    ).not.toThrow()
    expect(() => clearUnresolved("acme")).not.toThrow()
  })
})

describe("reconcileUnresolvedConcerns", () => {
  const latched = new Map([
    ["rulesets", ""],
    ["branchProtection", "tried PUT"],
  ])

  it("drops latched concerns the audit now reports enforced, keeps the rest", () => {
    const { resolvedIds, visible } = reconcileUnresolvedConcerns(latched, [
      { id: "rulesets", verdict: { state: "enforced" } },
      { id: "branchProtection", verdict: { state: "unenforced" } },
      { id: "pages", verdict: { state: "enforced" } }, // never latched
    ])
    expect(resolvedIds).toEqual(["rulesets"])
    expect([...visible.keys()]).toEqual(["branchProtection"])
  })

  it("returns the same map when nothing resolved (no re-render churn)", () => {
    const { resolvedIds, visible } = reconcileUnresolvedConcerns(latched, [
      { id: "rulesets", verdict: { state: "unenforced" } },
    ])
    expect(resolvedIds).toEqual([])
    expect(visible).toBe(latched)
  })
})
