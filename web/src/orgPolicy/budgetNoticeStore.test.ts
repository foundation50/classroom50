// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  dismissBudgetNotice,
  markBudgetCreated,
  readBudgetNotice,
} from "./budgetNoticeStore"

// happy-dom (v15) doesn't back window.localStorage here, so install a minimal
// in-memory store — the same shape the unresolvedStore test uses.
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

describe("budgetNoticeStore", () => {
  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it("defaults to not-created, not-dismissed", () => {
    const n = readBudgetNotice("acme")
    expect(n.created).toBe(false)
    expect(n.dismissed).toBe(false)
  })

  it("shows the banner after a create, hides it after dismiss", () => {
    markBudgetCreated("acme")
    const created = readBudgetNotice("acme")
    expect(created.created).toBe(true)
    expect(created.dismissed).toBe(false)

    dismissBudgetNotice("acme")
    const n = readBudgetNotice("acme")
    expect(n.created).toBe(true)
    expect(n.dismissed).toBe(true)
  })

  it("does not resurface after a re-run once dismissed (one-time per org)", () => {
    markBudgetCreated("acme")
    dismissBudgetNotice("acme")
    // A later setup re-run marks created again; dismissal must persist.
    markBudgetCreated("acme")
    expect(readBudgetNotice("acme").dismissed).toBe(true)
  })

  it("keys per-org", () => {
    markBudgetCreated("acme")
    expect(readBudgetNotice("acme").created).toBe(true)
    expect(readBudgetNotice("other").created).toBe(false)
  })

  it("tolerates corrupt JSON", () => {
    window.localStorage.setItem("c50:budget:notice:v1:acme", "{not json")
    const n = readBudgetNotice("acme")
    expect(n.created).toBe(false)
    expect(n.dismissed).toBe(false)
  })
})
