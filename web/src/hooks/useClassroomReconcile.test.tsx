// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"

const reconcile = vi.fn()
const invalidateQueries = vi.fn()

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}) as unknown,
}))
vi.mock("@/domain/classrooms", () => ({
  // Pass-through: the reconcile itself is what we assert on.
  withGitConflictRetry: (fn: () => unknown) => fn(),
}))
vi.mock("@/domain/reconcileClassroom", () => ({
  reconcileClassroom: (...args: unknown[]) => reconcile(...args),
  // Real-shaped stand-in so the hook's `instanceof` latch check works.
  ClassroomReconcilePermanentError: class ClassroomReconcilePermanentError extends Error {
    readonly cause: unknown
    constructor(cause: unknown) {
      super("classroom reconcile hit a permanently unconvergeable state")
      this.name = "ClassroomReconcilePermanentError"
      this.cause = cause
    }
  },
}))

import { useClassroomReconcile } from "./useClassroomReconcile"
// Deliberately NOT mocked: the wiring test below proves the accessor handed to
// reconcileClassroom reads the real module-scoped suppression store.
import { suppressedLoginsFor } from "@/hooks/useSuppressedLogins"
import { ClassroomReconcilePermanentError } from "@/domain/reconcileClassroom"
import { GitHubAPIError } from "@/github-core/errors"
import type { ClassroomReconcileResult } from "@/domain/reconcileClassroom"

const healthy: ClassroomReconcileResult = {
  skipped: false,
  description: { changed: false },
  staffCreated: [],
  invitesBackfilled: [],
  rosterChanged: false,
}

const archived: ClassroomReconcileResult = {
  skipped: true,
  description: { changed: false },
  staffCreated: [],
  invitesBackfilled: [],
  rosterChanged: false,
}

function githubAPIError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "/orgs/org/teams/classroom50-cs101",
    message: `status ${status}`,
    body: {},
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })
}

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  qc.invalidateQueries = invalidateQueries as never
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  reconcile.mockReset()
  invalidateQueries.mockReset()
})

describe("useClassroomReconcile", () => {
  it("does nothing when not enabled (non-owner viewer)", () => {
    renderHook(() => useClassroomReconcile("org", "cs101", false), {
      wrapper: wrapper(),
    })
    expect(reconcile).not.toHaveBeenCalled()
  })

  // The returned isPending is what the roster page's "sync in progress"
  // banner/lock hangs off — pin the full lifecycle: idle -> pending -> settled.
  it("exposes the run's in-flight state via isPending", async () => {
    let settle!: (value: ClassroomReconcileResult) => void
    reconcile.mockImplementation(
      () =>
        new Promise<ClassroomReconcileResult>((resolve) => {
          settle = resolve
        }),
    )
    const { result } = renderHook(
      () => useClassroomReconcile("org", "cs101", true),
      { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current.isPending).toBe(true))
    settle(healthy)
    await waitFor(() => expect(result.current.isPending).toBe(false))
  })

  it("fires once per (org, classroom) with the classroom as a variable", async () => {
    reconcile.mockResolvedValue(healthy)
    renderHook(() => useClassroomReconcile("org", "cs101", true), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(),
      "org",
      "cs101",
      undefined,
      // The suppressed-logins accessor: the pass runs while the roster stays
      // interactive, so it must honor mid-pass unenrolls.
      expect.any(Function),
    )
  })

  it("forwards the acting owner as the creator to drop from non-teacher teams", async () => {
    reconcile.mockResolvedValue(healthy)
    renderHook(() => useClassroomReconcile("org", "cs101", true, "prof"), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(),
      "org",
      "cs101",
      "prof",
      expect.any(Function),
    )
  })

  it("threads a LIVE accessor to the real suppression store for the run's own classroom", async () => {
    // expect.any(Function) above only shapes the call — this proves the seam:
    // the accessor reconcileClassroom receives must read the same module store
    // the roster page writes, at CALL time (so a mid-pass unenroll is honored),
    // and only for its own (org, classroom).
    suppressedLoginsFor("org", "cs101").clear()
    suppressedLoginsFor("org", "cs102").clear()
    try {
      reconcile.mockResolvedValue(healthy)
      renderHook(() => useClassroomReconcile("org", "cs101", true), {
        wrapper: wrapper(),
      })
      await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))

      const accessor = reconcile.mock.calls[0][4] as () => Set<string>
      expect(accessor()).toEqual(new Set())

      // Recorded AFTER the reconcile call started — a snapshot captured at
      // wiring time would miss it.
      suppressedLoginsFor("org", "cs101").remember(["gone"])
      expect(accessor().has("gone")).toBe(true)

      // Suppression is classroom-scoped: a sibling classroom's unenroll must
      // not leak into this run's exclude set.
      suppressedLoginsFor("org", "cs102").remember(["elsewhere"])
      expect(accessor().has("elsewhere")).toBe(false)
    } finally {
      suppressedLoginsFor("org", "cs101").clear()
      suppressedLoginsFor("org", "cs102").clear()
    }
  })

  it("does NOT invalidate anything when the classroom was already converged", async () => {
    reconcile.mockResolvedValue(healthy)
    renderHook(() => useClassroomReconcile("org", "cs101", true), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(invalidateQueries).not.toHaveBeenCalled()
  })

  it("invalidates the my-teams cache only when the description changed", async () => {
    reconcile.mockResolvedValue({
      ...healthy,
      description: { changed: true, slug: "classroom50-cs101" },
    })
    renderHook(() => useClassroomReconcile("org", "cs101", true), {
      wrapper: wrapper(),
    })
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: expect.arrayContaining(["my-teams"]),
        }),
      ),
    )
  })

  it("invalidates classroom.json when a staff team was backfilled", async () => {
    reconcile.mockResolvedValue({ ...healthy, staffCreated: ["hta"] })
    renderHook(() => useClassroomReconcile("org", "cs101", true), {
      wrapper: wrapper(),
    })
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: expect.arrayContaining([
            expect.stringContaining("cs101/classroom.json"),
          ]),
        }),
      ),
    )
  })

  it("invalidates the RUN's own classroom on a staff-team create, not the current one", async () => {
    // A late-resolving cs101 reconcile must invalidate cs101's caches even after
    // the hook has navigated to cs202 — the mutation-variable invariant.
    let resolveFirst: (v: ClassroomReconcileResult) => void = () => {}
    reconcile.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveFirst = res
        }),
    )
    reconcile.mockResolvedValue(healthy)

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useClassroomReconcile("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))

    rerender({ classroom: "cs202" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))

    resolveFirst({
      ...healthy,
      staffCreated: ["hta"],
    })
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: expect.arrayContaining([
            expect.stringContaining("cs101/classroom.json"),
          ]),
        }),
      ),
    )
    const hitCs202 = invalidateQueries.mock.calls.some((c) =>
      JSON.stringify(c[0]).includes("cs202/classroom.json"),
    )
    expect(hitCs202).toBe(false)
  })

  it("retries on re-entry after a transient failed run (key released)", async () => {
    reconcile.mockRejectedValueOnce(new Error("boom"))
    reconcile.mockResolvedValue(healthy)

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useClassroomReconcile("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    rerender({ classroom: "cs101" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3))
  })

  it("RETRIES on re-entry after a plain 404 (transient — not the wrong-slug case)", async () => {
    // A bare GitHubAPIError 404 (a propagating commit) is transient now: it
    // releases the key so a later entry retries,
    // instead of latching the whole classroom heal off for the mount.
    reconcile.mockRejectedValueOnce(githubAPIError(404))
    reconcile.mockResolvedValue(healthy)

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useClassroomReconcile("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    rerender({ classroom: "cs101" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3))
  })

  it("does NOT re-fire after a ClassroomReconcilePermanentError (wrong slug never converges)", async () => {
    reconcile.mockRejectedValueOnce(
      new ClassroomReconcilePermanentError(githubAPIError(404)),
    )
    reconcile.mockResolvedValue(healthy)

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useClassroomReconcile("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    rerender({ classroom: "cs101" })
    await new Promise((r) => setTimeout(r, 50))
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  it("RETRIES on re-entry after an archived skip (key released so un-archive re-reconciles)", async () => {
    // A skipped (archived) run resolves successfully but must NOT latch: if the
    // classroom is un-archived within the same mount, re-entry re-reconciles.
    reconcile.mockResolvedValueOnce(archived)
    reconcile.mockResolvedValue(healthy)

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useClassroomReconcile("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    rerender({ classroom: "cs101" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3))
  })

  it("does NOT re-fire after a permanent 403 the viewer can't fix", async () => {
    reconcile.mockRejectedValueOnce(githubAPIError(403))
    reconcile.mockResolvedValue(healthy)

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useClassroomReconcile("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    rerender({ classroom: "cs101" })
    await new Promise((r) => setTimeout(r, 50))
    expect(reconcile).toHaveBeenCalledTimes(2)
  })
})
