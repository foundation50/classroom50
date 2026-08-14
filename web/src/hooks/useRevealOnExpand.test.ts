// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, act, cleanup } from "@testing-library/react"

import { useRevealOnExpand } from "./useRevealOnExpand"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Position the body element's measured rect, then run the settle timer.
const revealWith = (rect: { top: number; bottom: number }) => {
  vi.useFakeTimers()
  const scrollBy = vi.fn()
  vi.stubGlobal("scrollBy", scrollBy)
  Object.defineProperty(window, "innerHeight", {
    value: 800,
    configurable: true,
  })

  const { result } = renderHook(() => useRevealOnExpand())
  const el = document.createElement("div")
  el.getBoundingClientRect = () =>
    ({ top: rect.top, bottom: rect.bottom }) as DOMRect
  result.current.bodyRef.current = el as HTMLDivElement

  act(() => result.current.reveal())
  act(() => void vi.advanceTimersByTime(500))
  return scrollBy
}

describe("useRevealOnExpand", () => {
  it("does not scroll when the expanded content already fits", () => {
    // Bottom at 500 in an 800px viewport: fully visible, so the reading
    // position must be left alone.
    expect(revealWith({ top: 300, bottom: 500 })).not.toHaveBeenCalled()
  })

  it("scrolls just enough to bring clipped content into view", () => {
    // Bottom at 900 overflows an 800px viewport by 100, plus a 24px margin.
    const scrollBy = revealWith({ top: 600, bottom: 900 })
    expect(scrollBy).toHaveBeenCalledWith(
      expect.objectContaining({ top: 124, behavior: "smooth" }),
    )
  })

  it("never scrolls the toggle above it out of view", () => {
    // A panel taller than the viewport would need a huge scroll; the amount is
    // capped by the body's own top offset so the toggle stays on screen.
    const scrollBy = revealWith({ top: 40, bottom: 2000 })
    expect(scrollBy).toHaveBeenCalledWith(
      expect.objectContaining({ top: 16, behavior: "smooth" }),
    )
  })

  it("does nothing when the body never mounted", () => {
    vi.useFakeTimers()
    const scrollBy = vi.fn()
    vi.stubGlobal("scrollBy", scrollBy)
    const { result } = renderHook(() => useRevealOnExpand())
    act(() => result.current.reveal())
    act(() => void vi.advanceTimersByTime(500))
    expect(scrollBy).not.toHaveBeenCalled()
  })
})
