// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import { useOnlineStatus } from "./useOnlineStatus"

function setNavigatorOnLine(value: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value,
  })
}

describe("useOnlineStatus", () => {
  afterEach(() => {
    setNavigatorOnLine(true)
    vi.restoreAllMocks()
  })

  it("seeds from navigator.onLine", () => {
    setNavigatorOnLine(false)
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(false)
  })

  it("flips to offline when the offline event fires", () => {
    setNavigatorOnLine(true)
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(true)

    act(() => {
      setNavigatorOnLine(false)
      window.dispatchEvent(new Event("offline"))
    })
    expect(result.current).toBe(false)
  })

  it("recovers to online when the online event fires", () => {
    setNavigatorOnLine(false)
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(false)

    act(() => {
      setNavigatorOnLine(true)
      window.dispatchEvent(new Event("online"))
    })
    expect(result.current).toBe(true)
  })

  it("unsubscribes on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() => useOnlineStatus())
    unmount()
    expect(remove).toHaveBeenCalledWith("online", expect.any(Function))
    expect(remove).toHaveBeenCalledWith("offline", expect.any(Function))
  })
})
