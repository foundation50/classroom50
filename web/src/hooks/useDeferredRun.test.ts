// @vitest-environment happy-dom
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest"
import { renderHook, act, cleanup } from "@testing-library/react"

import { useDeferredRun } from "./useDeferredRun"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("useDeferredRun", () => {
  it("runs the callback on the next macrotask, not synchronously", () => {
    const { result } = renderHook(() => useDeferredRun())
    const fn = vi.fn()

    act(() => result.current(fn))
    expect(fn).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("replaces a still-pending handoff instead of firing both", () => {
    const { result } = renderHook(() => useDeferredRun())
    const first = vi.fn()
    const second = vi.fn()

    act(() => {
      result.current(first)
      result.current(second)
    })
    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("cancels the pending handoff on unmount", () => {
    const { result, unmount } = renderHook(() => useDeferredRun())
    const fn = vi.fn()

    act(() => result.current(fn))
    unmount()
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(fn).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("allows a second handoff after the first has fired", () => {
    const { result } = renderHook(() => useDeferredRun())
    const fn = vi.fn()

    act(() => result.current(fn))
    act(() => {
      vi.advanceTimersByTime(0)
    })
    act(() => result.current(fn))
    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(fn).toHaveBeenCalledTimes(2)
  })
})
