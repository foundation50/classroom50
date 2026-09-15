import { describe, expect, it } from "vitest"
import { anyAbortSignal, groupBy } from "./platformShims"

describe("anyAbortSignal", () => {
  it("aborts when any input aborts, forwarding the reason", () => {
    const a = new AbortController()
    const b = new AbortController()
    const signal = anyAbortSignal([a.signal, b.signal])
    expect(signal.aborted).toBe(false)
    b.abort(new Error("b"))
    expect(signal.aborted).toBe(true)
    expect((signal.reason as Error).message).toBe("b")
  })

  it("is already aborted when an input already was", () => {
    const a = new AbortController()
    a.abort("early")
    const signal = anyAbortSignal([a.signal, new AbortController().signal])
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe("early")
  })
})

describe("groupBy", () => {
  it("groups in first-seen key order like Map.groupBy", () => {
    const groups = groupBy(["b1", "a1", "b2"], (s) => s[0])
    expect([...groups.keys()]).toEqual(["b", "a"])
    expect(groups.get("b")).toEqual(["b1", "b2"])
    expect(groups.get("a")).toEqual(["a1"])
  })
})
