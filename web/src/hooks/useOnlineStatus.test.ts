// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

import { useOnlineStatus, __resetOnlineStatusForTest } from "./useOnlineStatus"
import * as internetLiveness from "@/lib/internetLiveness"

function setNavigatorOnLine(value: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value,
  })
}

let livenessSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  __resetOnlineStatusForTest()
  livenessSpy = vi.spyOn(internetLiveness, "checkInternetLiveness")
})

afterEach(() => {
  setNavigatorOnLine(true)
  vi.restoreAllMocks()
})

describe("useOnlineStatus", () => {
  it("starts online and doesn't probe while navigator reports online", () => {
    setNavigatorOnLine(true)
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(true)
    expect(livenessSpy).not.toHaveBeenCalled()
  })

  it("stays online on a spurious offline event when the probe still reaches the internet", async () => {
    livenessSpy.mockResolvedValue(true)
    setNavigatorOnLine(true)
    const { result } = renderHook(() => useOnlineStatus())

    await act(async () => {
      setNavigatorOnLine(false)
      window.dispatchEvent(new Event("offline"))
    })

    expect(livenessSpy).toHaveBeenCalled()
    expect(result.current).toBe(true)
  })

  it("goes offline only after the liveness probe also fails", async () => {
    livenessSpy.mockResolvedValue(false)
    setNavigatorOnLine(true)
    const { result } = renderHook(() => useOnlineStatus())

    act(() => {
      setNavigatorOnLine(false)
      window.dispatchEvent(new Event("offline"))
    })

    await waitFor(() => expect(result.current).toBe(false))
  })

  it("seeds a cold load that starts offline through the same corroborated path", async () => {
    livenessSpy.mockResolvedValue(false)
    setNavigatorOnLine(false)
    const { result } = renderHook(() => useOnlineStatus())

    await waitFor(() => expect(result.current).toBe(false))
    expect(livenessSpy).toHaveBeenCalled()
  })

  it("recovers immediately on the online event without waiting for a probe", async () => {
    livenessSpy.mockResolvedValue(false)
    setNavigatorOnLine(false)
    const { result } = renderHook(() => useOnlineStatus())
    await waitFor(() => expect(result.current).toBe(false))

    act(() => {
      setNavigatorOnLine(true)
      window.dispatchEvent(new Event("online"))
    })
    expect(result.current).toBe(true)
  })

  it("discards a stale offline probe that resolves after the link is restored", async () => {
    let resolveProbe: (online: boolean) => void = () => {}
    livenessSpy.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve
        }),
    )
    setNavigatorOnLine(false)
    const { result } = renderHook(() => useOnlineStatus())

    // Link comes back before the probe settles.
    act(() => {
      setNavigatorOnLine(true)
      window.dispatchEvent(new Event("online"))
    })
    expect(result.current).toBe(true)

    // The now-stale probe reports "offline"; it must be ignored.
    await act(async () => {
      resolveProbe(false)
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
