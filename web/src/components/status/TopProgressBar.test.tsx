// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

vi.mock("motion/react", () => ({
  AnimatePresence: () => null,
  motion: { div: () => null },
  useMotionValue: () => ({ set: () => {} }),
  animate: () => ({ stop: () => {} }),
}))

import { useRevealCycle } from "./TopProgressBar"

// RouteProgressBar.test covers the visible flag's timing; this pins the
// transition callbacks a bar hangs its fill on, since a dropped `onShow` would
// leave the trickle at scaleX(0) with every visibility assertion still green.
describe("useRevealCycle transitions", () => {
  const onShow = vi.fn()
  const onSettle = vi.fn()
  const onHide = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    onShow.mockClear()
    onSettle.mockClear()
    onHide.mockClear()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  const mount = () =>
    renderHook(
      ({ active }: { active: boolean }) =>
        useRevealCycle(active, { onShow, onSettle, onHide }),
      { initialProps: { active: false } },
    )

  it("fires onShow with the reveal, onSettle when active drops, onHide after the settle delay", () => {
    const { result, rerender } = mount()
    rerender({ active: true })
    expect(onShow).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(120))
    expect(result.current).toBe(true)
    expect(onShow).toHaveBeenCalledTimes(1)
    expect(onSettle).not.toHaveBeenCalled()

    rerender({ active: false })
    expect(onSettle).toHaveBeenCalledTimes(1)
    expect(onHide).not.toHaveBeenCalled()
    expect(result.current).toBe(true)

    act(() => vi.advanceTimersByTime(180))
    expect(result.current).toBe(false)
    expect(onHide).toHaveBeenCalledTimes(1)
  })

  it("fires nothing for a cycle that settles inside the reveal delay", () => {
    const { rerender } = mount()
    rerender({ active: true })
    act(() => vi.advanceTimersByTime(100))
    rerender({ active: false })
    act(() => vi.advanceTimersByTime(500))
    expect(onShow).not.toHaveBeenCalled()
    expect(onSettle).not.toHaveBeenCalled()
    expect(onHide).not.toHaveBeenCalled()
  })

  it("honors a longer showDelayMs", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useRevealCycle(active, { showDelayMs: 1000, onShow }),
      { initialProps: { active: false } },
    )
    rerender({ active: true })
    act(() => vi.advanceTimersByTime(900))
    expect(result.current).toBe(false)
    expect(onShow).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBe(true)
    expect(onShow).toHaveBeenCalledTimes(1)
  })

  it("reads the latest callbacks when a timer fires", () => {
    const late = vi.fn()
    const { rerender } = renderHook(
      ({ active, cb }: { active: boolean; cb: () => void }) =>
        useRevealCycle(active, { onShow: cb }),
      { initialProps: { active: false, cb: onShow } },
    )
    rerender({ active: true, cb: onShow })
    // A re-render mid-delay swaps the closure; the timer must see the new one.
    rerender({ active: true, cb: late })
    act(() => vi.advanceTimersByTime(120))
    expect(onShow).not.toHaveBeenCalled()
    expect(late).toHaveBeenCalledTimes(1)
  })
})
