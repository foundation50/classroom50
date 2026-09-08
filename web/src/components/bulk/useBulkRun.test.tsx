// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/useBeforeUnloadGuard", () => ({
  useBeforeUnloadGuard: vi.fn(),
}))
import { useBeforeUnloadGuard } from "@/hooks/useBeforeUnloadGuard"

import { useBulkRun } from "./useBulkRun"

const view = { headline: "done", sections: [] }

describe("useBulkRun", () => {
  it("walks idle -> working -> complete and holds the tab only while working", () => {
    const { result } = renderHook(() => useBulkRun())
    expect(result.current.phase).toBe("idle")
    expect(useBeforeUnloadGuard).toHaveBeenLastCalledWith(false)

    let started = false
    act(() => {
      started = result.current.begin(3, "starting")
    })
    expect(started).toBe(true)
    expect(result.current.phase).toBe("working")
    expect(result.current.busy).toBe(true)
    expect(result.current.progress).toEqual({
      processed: 0,
      total: 3,
      message: "starting",
    })
    expect(useBeforeUnloadGuard).toHaveBeenLastCalledWith(true)

    act(() =>
      result.current.setProgress({ processed: 2, total: 3, message: "b" }),
    )
    expect(result.current.progress.processed).toBe(2)

    act(() => result.current.complete(view, "complete"))
    expect(result.current.phase).toBe("complete")
    expect(result.current.result).toBe(view)
    expect(useBeforeUnloadGuard).toHaveBeenLastCalledWith(false)
  })

  it("refuses a second begin while a run is in flight", () => {
    const { result } = renderHook(() => useBulkRun())
    act(() => void result.current.begin(1))
    let second: boolean | undefined
    act(() => {
      second = result.current.begin(5)
    })
    expect(second).toBe(false)
    // The first run's progress is untouched.
    expect(result.current.progress.total).toBe(1)
    // A finished run frees the latch.
    act(() => result.current.complete(view, "error"))
    act(() => {
      second = result.current.begin(5)
    })
    expect(second).toBe(true)
  })

  it("fail records the message and leaves no result", () => {
    const { result } = renderHook(() => useBulkRun())
    act(() => void result.current.begin(1))
    act(() => result.current.fail("boom"))
    expect(result.current.phase).toBe("error")
    expect(result.current.error).toBe("boom")
    expect(result.current.result).toBeNull()
  })

  it("resets when the reset flag turns true, not when it turns false", () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useBulkRun(open),
      { initialProps: { open: true } },
    )
    act(() => void result.current.begin(1))
    act(() => result.current.complete(view, "complete"))

    // Closing keeps the last result visible through the exit animation.
    rerender({ open: false })
    expect(result.current.phase).toBe("complete")
    expect(result.current.result).toBe(view)

    // Reopening starts fresh.
    rerender({ open: true })
    expect(result.current.phase).toBe("idle")
    expect(result.current.result).toBeNull()
  })

  it("reports unmounted and swallows completions after unmount", () => {
    const { result, unmount } = renderHook(() => useBulkRun())
    const run = result.current
    act(() => void run.begin(1))
    expect(run.isMounted()).toBe(true)
    unmount()
    expect(run.isMounted()).toBe(false)
    // No throw, no setState on an unmounted component.
    run.setProgress({ processed: 1, total: 1, message: "" })
    run.complete(view, "complete")
    run.fail("late")
  })
})
