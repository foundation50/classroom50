// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

let hashValue = ""

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { hash: hashValue } }),
}))

import { useHashSectionHighlight } from "./useHashSectionHighlight"

beforeEach(() => {
  vi.useFakeTimers()
  hashValue = ""
  document.body.innerHTML = ""
  // rAF isn't provided by fake timers; make it synchronous so the scroll retry
  // resolves within the test.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  vi.stubGlobal("cancelAnimationFrame", () => {})
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("useHashSectionHighlight", () => {
  it("returns null and does nothing when there is no hash", () => {
    const { result } = renderHook(() => useHashSectionHighlight())
    expect(result.current).toBeNull()
  })

  it("scrolls the matching section and highlights it", () => {
    const scrollIntoView = vi.fn()
    const el = document.createElement("section")
    el.id = "service-token"
    el.scrollIntoView = scrollIntoView
    document.body.appendChild(el)

    hashValue = "service-token"
    const { result } = renderHook(() => useHashSectionHighlight())

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    })
    expect(result.current).toBe("service-token")
  })

  it("drops the highlight after the timeout", () => {
    const el = document.createElement("section")
    el.id = "danger-zone"
    el.scrollIntoView = vi.fn()
    document.body.appendChild(el)

    hashValue = "danger-zone"
    const { result } = renderHook(() => useHashSectionHighlight())
    expect(result.current).toBe("danger-zone")

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(result.current).toBeNull()
  })

  it("still highlights when the element is not mounted yet", () => {
    hashValue = "not-mounted-yet"
    const { result } = renderHook(() => useHashSectionHighlight())
    expect(result.current).toBe("not-mounted-yet")
  })
})
