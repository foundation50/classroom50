// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

// Drive the extracted roster auto-sync hook directly, since the rendered smoke
// test can't exercise it (it supplies no drift). These pin the highest-risk
// part of the U14 split: the once-per-classroom guard ref, and re-arm.

import { useRosterAutoSync } from "./useRosterAutoSync"
import type { SuppressedLogins } from "@/hooks/useSuppressedLogins"

const noSuppression: SuppressedLogins = {
  remember: vi.fn(),
  forget: vi.fn(),
  has: () => false,
  snapshot: () => new Set<string>(),
  clear: vi.fn(),
}

beforeEach(() => vi.clearAllMocks())

describe("useRosterAutoSync", () => {
  const base = {
    classroom: "cs101",
    ready: true,
    csvMissingLogins: ["ghost"],
    backfillNeededLogins: [] as string[],
    suppressedLogins: noSuppression,
    syncPending: false,
  }

  it("fires runSync once when drift exists", () => {
    const runSync = vi.fn()
    renderHook(() => useRosterAutoSync({ ...base, runSync }))
    expect(runSync).toHaveBeenCalledTimes(1)
  })

  it("fires on backfill-only drift (login-only row, no csv-missing)", () => {
    const runSync = vi.fn()
    renderHook(() =>
      useRosterAutoSync({
        ...base,
        csvMissingLogins: [],
        backfillNeededLogins: ["legacyRow"],
        runSync,
      }),
    )
    expect(runSync).toHaveBeenCalledTimes(1)
  })

  it("stays gated until ready", () => {
    const runSync = vi.fn()
    const { rerender } = renderHook((props) => useRosterAutoSync(props), {
      initialProps: {
        ...base,
        ready: false,
        runSync,
      },
    })
    expect(runSync).not.toHaveBeenCalled()
    rerender({ ...base, ready: true, runSync })
    expect(runSync).toHaveBeenCalledTimes(1)
  })

  it("does not fire when there is no drift", () => {
    const runSync = vi.fn()
    renderHook(() =>
      useRosterAutoSync({
        ...base,
        csvMissingLogins: [],
        backfillNeededLogins: [],
        runSync,
      }),
    )
    expect(runSync).not.toHaveBeenCalled()
  })

  it("skips drift logins the teacher just unenrolled (dropSuppressed)", () => {
    const runSync = vi.fn()
    renderHook(() =>
      useRosterAutoSync({
        ...base,
        suppressedLogins: { ...noSuppression, has: () => true },
        runSync,
      }),
    )
    expect(runSync).not.toHaveBeenCalled()
  })

  it("does not stack a fire while a sync is already pending", () => {
    const runSync = vi.fn()
    renderHook(() => useRosterAutoSync({ ...base, syncPending: true, runSync }))
    expect(runSync).not.toHaveBeenCalled()
  })

  it("re-arms after drift clears then re-appears", () => {
    const runSync = vi.fn()
    const { rerender } = renderHook((props) => useRosterAutoSync(props), {
      initialProps: { ...base, runSync },
    })
    expect(runSync).toHaveBeenCalledTimes(1)
    // Drift clears -> the per-classroom guard resets.
    rerender({ ...base, csvMissingLogins: [], runSync })
    // Drift re-appears -> it fires again for the same classroom.
    rerender({ ...base, csvMissingLogins: ["ghost2"], runSync })
    expect(runSync).toHaveBeenCalledTimes(2)
  })
})
