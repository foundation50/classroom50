// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

// Drive the two extracted roster auto-effect hooks directly, since the rendered
// smoke test can't exercise them (its migrate mock never settles the gate and it
// supplies no drift). These pin the highest-risk part of the U14 split: the
// once-per-classroom guard refs, the migrate-before-sync gate, and re-arm.

const migrateMutate = vi.fn()
vi.mock("@/hooks/mutations/useMigrateRoster", () => ({
  useMigrateRoster: () => ({ mutate: migrateMutate, isPending: false }),
}))

import { useRosterAutoMigrate } from "./useRosterAutoMigrate"
import { useRosterAutoSync } from "./useRosterAutoSync"
import type { SuppressedLogins } from "@/hooks/useSuppressedLogins"

const noSuppression: SuppressedLogins = {
  remember: vi.fn(),
  forget: vi.fn(),
  has: () => false,
  clear: vi.fn(),
}

beforeEach(() => vi.clearAllMocks())

describe("useRosterAutoMigrate", () => {
  it("fires once per classroom and opens the gate via onSettled", () => {
    const { result, rerender } = renderHook(
      ({ classroom, ready }) => useRosterAutoMigrate("acme", classroom, ready),
      { initialProps: { classroom: "cs101", ready: true } },
    )
    expect(migrateMutate).toHaveBeenCalledTimes(1)
    // The gate stays null until onSettled runs...
    expect(result.current.migrateSettledFor).toBeNull()
    // ...even on the error path (onSettled, not onSuccess).
    migrateMutate.mock.calls[0][1].onSettled()
    rerender({ classroom: "cs101", ready: true })
    expect(result.current.migrateSettledFor).toBe("cs101")
    // A same-classroom rerender must not re-fire.
    expect(migrateMutate).toHaveBeenCalledTimes(1)
  })

  it("does not fire until ready, then re-fires for a new classroom", () => {
    const { rerender } = renderHook(
      ({ classroom, ready }) => useRosterAutoMigrate("acme", classroom, ready),
      { initialProps: { classroom: "cs101", ready: false } },
    )
    expect(migrateMutate).not.toHaveBeenCalled()
    rerender({ classroom: "cs101", ready: true })
    expect(migrateMutate).toHaveBeenCalledTimes(1)
    // A $classroom route switch on the reused instance must migrate the new one.
    rerender({ classroom: "cs202", ready: true })
    expect(migrateMutate).toHaveBeenCalledTimes(2)
  })
})

describe("useRosterAutoSync", () => {
  const base = {
    classroom: "cs101",
    ready: true,
    migrateSettledFor: "cs101",
    csvMissingLogins: ["ghost"],
    backfillNeededLogins: [] as string[],
    suppressedLogins: noSuppression,
    syncPending: false,
  }

  it("fires runSync once when drift exists and migrate has settled", () => {
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

  it("stays gated until migrate settles for this classroom", () => {
    const runSync = vi.fn()
    const { rerender } = renderHook((props) => useRosterAutoSync(props), {
      initialProps: {
        ...base,
        migrateSettledFor: null as string | null,
        runSync,
      },
    })
    expect(runSync).not.toHaveBeenCalled()
    rerender({ ...base, migrateSettledFor: "cs101", runSync })
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
