// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"

const migrate = vi.fn()
const invalidateQueries = vi.fn()

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}) as unknown,
}))
vi.mock("@/domain/classrooms", () => ({
  // Pass-through: the migration itself is what we assert on.
  withGitConflictRetry: (fn: () => unknown) => fn(),
}))
vi.mock("@/github-core/mutations", () => ({
  migrateInstructorTeamToTeacher: (...args: unknown[]) => migrate(...args),
}))

import { useTeacherTeamMigration } from "./useTeacherTeamMigration"
import { GitHubAPIError } from "@/github-core/errors"

// A QueryClient whose invalidateQueries we can observe, mounted so useMutation
// works. onSuccess's invalidations are what a stale-closure bug would misdirect.
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
  migrate.mockReset()
  invalidateQueries.mockReset()
})

describe("useTeacherTeamMigration", () => {
  it("does nothing when not enabled (non-owner viewer)", () => {
    renderHook(() => useTeacherTeamMigration("org", "cs101", false), {
      wrapper: wrapper(),
    })
    expect(migrate).not.toHaveBeenCalled()
  })

  it("fires once per (org, classroom) with the classroom as a variable", async () => {
    migrate.mockResolvedValue({ changed: false })
    renderHook(() => useTeacherTeamMigration("org", "cs101", true), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(1))
    // org/classroom are passed to the domain call as arguments, not closed over.
    expect(migrate).toHaveBeenCalledWith(expect.anything(), "org", "cs101")
  })

  it("invalidates the RUN's own classroom on success, not the current one", async () => {
    // A late-resolving cs101 migration must invalidate cs101's caches even after
    // the hook has navigated to cs202 — the mutation-variable fix, not the old
    // closed-over org!/classroom!.
    let resolveFirst: (v: {
      changed: true
      phase: "create"
      teacherSlug: string
    }) => void = () => {}
    migrate.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveFirst = res
        }),
    )
    migrate.mockResolvedValue({ changed: false })

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useTeacherTeamMigration("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(1))

    // Navigate to cs202 before cs101's migration resolves.
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(2))

    // cs101's run resolves now (changed) — its onSuccess must target cs101.
    resolveFirst({ changed: true, phase: "create", teacherSlug: "s" })
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith(
        expect.objectContaining({
          queryKey: expect.arrayContaining([
            expect.stringContaining("cs101/classroom.json"),
          ]),
        }),
      ),
    )
    // And never cs202 (the current classroom the stale-closure bug would hit).
    const hitCs202 = invalidateQueries.mock.calls.some((c) =>
      JSON.stringify(c[0]).includes("cs202/classroom.json"),
    )
    expect(hitCs202).toBe(false)
  })

  it("retries on re-entry after a transient failed run (key released on error)", async () => {
    migrate.mockRejectedValueOnce(new Error("boom"))
    migrate.mockResolvedValue({ changed: false })

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useTeacherTeamMigration("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(1))
    // Navigate away and back: the transient cs101 failure released its in-flight
    // key on error, so re-entering cs101 retries rather than staying latched.
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(2))
    rerender({ classroom: "cs101" })
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(3))
    expect(migrate).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      "org",
      "cs101",
    )
  })

  it("does NOT re-fire on re-entry after a permanent (403) failure", async () => {
    // A forbidden, non-rate-limited refusal is one the viewer can't fix; the
    // hopeless create/grant/copy/commit chain must not re-run on every entry.
    const forbidden = new GitHubAPIError({
      status: 403,
      url: "/orgs/org/teams",
      message: "forbidden",
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
    migrate.mockRejectedValueOnce(forbidden)
    migrate.mockResolvedValue({ changed: false })

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useTeacherTeamMigration("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(1))
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(migrate).toHaveBeenCalledTimes(2))
    // Back to cs101: the permanent failure kept its key latched, so no re-fire.
    rerender({ classroom: "cs101" })
    await new Promise((r) => setTimeout(r, 50))
    expect(migrate).toHaveBeenCalledTimes(2)
  })
})
