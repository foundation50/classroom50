// @vitest-environment happy-dom
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest"
import { renderHook, act, cleanup } from "@testing-library/react"

import { useLingeringOpen } from "./useLingeringOpen"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("useLingeringOpen", () => {
  it("is true immediately when open, without waiting for an effect tick", () => {
    const { result } = renderHook(({ open }) => useLingeringOpen(open), {
      initialProps: { open: true },
    })
    expect(result.current).toBe(true)
  })

  it("lingers true after open flips false, then settles false after the delay", () => {
    const { result, rerender } = renderHook(
      ({ open }) => useLingeringOpen(open, 300),
      { initialProps: { open: true } },
    )

    rerender({ open: false })
    // Still true through the close animation window.
    expect(result.current).toBe(true)

    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(result.current).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(false)
  })

  it("cancels the pending timer on a rapid reopen inside the linger window", () => {
    const { result, rerender } = renderHook(
      ({ open }) => useLingeringOpen(open, 300),
      { initialProps: { open: true } },
    )

    rerender({ open: false })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    rerender({ open: true })

    // The stale close timer must not fire and flip the reopened content off.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(true)
  })

  it("starts false when mounted closed", () => {
    const { result } = renderHook(({ open }) => useLingeringOpen(open), {
      initialProps: { open: false },
    })
    expect(result.current).toBe(false)
  })

  it("clears its timer on unmount during the linger window", () => {
    const { rerender, unmount } = renderHook(
      ({ open }) => useLingeringOpen(open, 300),
      { initialProps: { open: true } },
    )
    rerender({ open: false })
    unmount()
    // Firing the timer after unmount must not warn/setState; advancing proves
    // the cleanup ran (vitest fails on unhandled errors).
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
