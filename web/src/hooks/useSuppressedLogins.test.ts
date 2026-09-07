// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import {
  dropSuppressed,
  suppressedLoginsFor,
  useSuppressedLogins,
} from "./useSuppressedLogins"

// The store is module-scoped by design (the reconcile hook reads it outside
// the roster page), so there is no reset hook. Drain every key a test touches
// through the public API so state never leaks between tests.
const KEYS: [string, string][] = [
  ["org", "cs101"],
  ["org", "cs102"],
  ["otherorg", "cs101"],
]

afterEach(() => {
  for (const [org, classroom] of KEYS) {
    suppressedLoginsFor(org, classroom).clear()
  }
})

describe("suppressedLoginsFor — per-(org, classroom) keying", () => {
  it("isolates a remembered login to its own org/classroom", () => {
    suppressedLoginsFor("org", "cs101").remember(["gone"])

    expect(suppressedLoginsFor("org", "cs101").has("gone")).toBe(true)
    // Unenroll is classroom-scoped: the same login must still backfill
    // normally in a sibling classroom and in another org's same-named one.
    expect(suppressedLoginsFor("org", "cs102").has("gone")).toBe(false)
    expect(suppressedLoginsFor("otherorg", "cs101").has("gone")).toBe(false)
  })

  it("shares one underlying set across accessor instances for the same key", () => {
    const writer = suppressedLoginsFor("org", "cs101")
    const reader = suppressedLoginsFor("org", "cs101")
    writer.remember(["gone"])
    expect(reader.has("gone")).toBe(true)
    reader.forget(["gone"])
    expect(writer.has("gone")).toBe(false)
  })
})

describe("suppressedLoginsFor — snapshot semantics", () => {
  it("returns a copy: mutating the snapshot never touches the store", () => {
    const store = suppressedLoginsFor("org", "cs101")
    store.remember(["gone"])

    const snap = store.snapshot()
    snap.delete("gone")
    snap.add("extra")

    expect(store.has("gone")).toBe(true)
    expect(store.has("extra")).toBe(false)
    expect(store.snapshot()).toEqual(new Set(["gone"]))
  })

  it("reflects the live store at call time, not at accessor creation", () => {
    const store = suppressedLoginsFor("org", "cs101")
    expect(store.snapshot()).toEqual(new Set())
    store.remember(["gone"])
    expect(store.snapshot()).toEqual(new Set(["gone"]))
  })
})

describe("suppressedLoginsFor — normalization, forget, clear", () => {
  it("normalizes on remember (trim + lowercase) and drops empty logins", () => {
    const store = suppressedLoginsFor("org", "cs101")
    store.remember(["  Alice ", "", "   "])
    expect(store.snapshot()).toEqual(new Set(["alice"]))
  })

  it("has() is an exact match on the stored (normalized) form; dropSuppressed normalizes the candidate side", () => {
    const store = suppressedLoginsFor("org", "cs101")
    store.remember(["Alice"])
    // `has` does no input normalization — callers pass normalized logins
    // (dropSuppressed does exactly that), so pin both halves of the contract.
    expect(store.has("alice")).toBe(true)
    expect(store.has("Alice")).toBe(false)
    expect(dropSuppressed([" ALICE ", "bob"], store)).toEqual(["bob"])
  })

  it("forget normalizes too, so a mixed-case re-enroll unsuppresses", () => {
    const store = suppressedLoginsFor("org", "cs101")
    store.remember(["gone"])
    store.forget(["  GONE "])
    expect(store.has("gone")).toBe(false)
  })

  it("clear empties only its own classroom's set", () => {
    suppressedLoginsFor("org", "cs101").remember(["a", "b"])
    suppressedLoginsFor("org", "cs102").remember(["c"])

    suppressedLoginsFor("org", "cs101").clear()

    expect(suppressedLoginsFor("org", "cs101").snapshot()).toEqual(new Set())
    expect(suppressedLoginsFor("org", "cs102").snapshot()).toEqual(
      new Set(["c"]),
    )
  })
})

describe("useSuppressedLogins", () => {
  it("hands the component the same store the module accessor writes", () => {
    const { result, rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useSuppressedLogins("org", classroom),
      { initialProps: { classroom: "cs101" } },
    )
    suppressedLoginsFor("org", "cs101").remember(["gone"])
    expect(result.current.has("gone")).toBe(true)

    // Memoized per (org, classroom): stable across re-renders, swapped on a
    // classroom change — and the new accessor reads the other classroom's set.
    const first = result.current
    rerender({ classroom: "cs101" })
    expect(result.current).toBe(first)
    rerender({ classroom: "cs102" })
    expect(result.current).not.toBe(first)
    expect(result.current.has("gone")).toBe(false)
  })
})
