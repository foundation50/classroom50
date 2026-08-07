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

// Simulate a cold page load in a given connectivity state: stage
// navigator.onLine, then re-run the module seed so `confirmedOffline` captures
// it exactly as it would at import time.
function coldStart(online: boolean) {
  setNavigatorOnLine(online)
  __resetOnlineStatusForTest()
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

  it("reads offline synchronously on a cold load that started hard-offline (#187)", () => {
    // resolveAuthStatus depends on this being false on the FIRST render (no
    // waiting for the probe) to hold a valid session instead of redirecting.
    livenessSpy.mockReturnValue(new Promise<boolean>(() => {}))
    coldStart(false)
    const { result } = renderHook(() => useOnlineStatus())
    expect(result.current).toBe(false)
  })

  it("still probes a cold offline start and clears it when a captive portal reaches the internet", async () => {
    livenessSpy.mockResolvedValue(true)
    coldStart(false)
    const { result } = renderHook(() => useOnlineStatus())

    // Synchronously offline from the seed...
    expect(result.current).toBe(false)
    // ...then the probe confirms the internet is actually reachable and clears it.
    await waitFor(() => expect(result.current).toBe(true))
    expect(livenessSpy).toHaveBeenCalled()
  })

  it("keeps a cold offline start offline when the probe also fails", async () => {
    livenessSpy.mockResolvedValue(false)
    coldStart(false)
    const { result } = renderHook(() => useOnlineStatus())

    expect(result.current).toBe(false)
    // Stays offline after the probe confirms unreachability.
    await waitFor(() => expect(livenessSpy).toHaveBeenCalled())
    expect(result.current).toBe(false)
  })

  it("recovers immediately on the online event without waiting for a probe", async () => {
    livenessSpy.mockResolvedValue(false)
    coldStart(false)
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
    coldStart(false)
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

  it("re-arms on a second offline event while a probe is still in flight", async () => {
    // First probe never settles; a second offline event must start a fresh
    // probe (new epoch) rather than being swallowed by the in-flight one.
    coldStart(true)
    livenessSpy.mockReturnValueOnce(new Promise<boolean>(() => {}))
    livenessSpy.mockResolvedValueOnce(false)
    const { result } = renderHook(() => useOnlineStatus())

    act(() => {
      setNavigatorOnLine(false)
      window.dispatchEvent(new Event("offline"))
    })
    // First probe is pending -> still online.
    expect(result.current).toBe(true)

    await act(async () => {
      window.dispatchEvent(new Event("offline"))
    })
    // Second probe resolved offline; its result applies.
    expect(livenessSpy).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current).toBe(false))
  })

  it("unsubscribes on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() => useOnlineStatus())
    unmount()
    expect(remove).toHaveBeenCalledWith("online", expect.any(Function))
    expect(remove).toHaveBeenCalledWith("offline", expect.any(Function))
  })
})
