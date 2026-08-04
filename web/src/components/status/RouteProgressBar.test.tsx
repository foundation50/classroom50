// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"

// Control the global in-flight count directly. useIsFetching is the only signal
// the bar reacts to, so mocking it lets fake timers drive the show/hide logic
// deterministically without wiring real queries.
let fetchingCount = 0
vi.mock("@tanstack/react-query", () => ({
  useIsFetching: () => fetchingCount,
}))

// Render the animated bar as a plain element and no-op the motion value/animate
// helpers; the test targets the timer + visibility logic, not the tween.
// AnimatePresence just renders its children so `visible` maps to DOM presence
// synchronously.
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: (props: Record<string, unknown>) => <div {...props} />,
  },
  useMotionValue: () => ({ set: () => {} }),
  animate: () => ({ stop: () => {} }),
}))

import { RouteProgressBar } from "./RouteProgressBar"

const bar = () => document.querySelector(".bg-primary")

let rerender: (ui: ReactNode) => void = () => {}

const mount = () => {
  const view = render(<RouteProgressBar />)
  rerender = view.rerender
}

// Change the mocked in-flight count and re-render the SAME instance so its
// effect re-runs with the new value (a fresh render() would mount a new tree).
const setFetching = (n: number) => {
  act(() => {
    fetchingCount = n
    rerender(<RouteProgressBar />)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  fetchingCount = 0
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  cleanup()
  vi.clearAllMocks()
})

describe("RouteProgressBar", () => {
  it("stays hidden while nothing is fetching", () => {
    mount()
    act(() => vi.advanceTimersByTime(500))
    expect(bar()).toBeNull()
  })

  it("does not flash for a fetch that settles within the show delay", () => {
    mount()
    setFetching(1)
    act(() => vi.advanceTimersByTime(100)) // < SHOW_DELAY_MS (120)
    setFetching(0)
    act(() => vi.advanceTimersByTime(200))
    expect(bar()).toBeNull()
  })

  it("reveals the bar after the show delay while fetching", () => {
    mount()
    setFetching(1)
    expect(bar()).toBeNull()
    act(() => vi.advanceTimersByTime(120))
    expect(bar()).not.toBeNull()
  })

  it("reveals on schedule even as the fetch count churns", () => {
    mount()
    setFetching(1)
    // A staggered burst: the count keeps changing before the 120ms reveal.
    // The show-timer must NOT reset on each change, or the bar never appears.
    act(() => vi.advanceTimersByTime(50))
    setFetching(2)
    act(() => vi.advanceTimersByTime(50))
    setFetching(3)
    act(() => vi.advanceTimersByTime(30)) // total 130ms > SHOW_DELAY_MS
    expect(bar()).not.toBeNull()
  })

  it("hides again after fetches settle", () => {
    mount()
    setFetching(1)
    act(() => vi.advanceTimersByTime(120))
    expect(bar()).not.toBeNull()
    setFetching(0)
    act(() => vi.advanceTimersByTime(200)) // > HIDE_DELAY_MS (180)
    expect(bar()).toBeNull()
  })
})
