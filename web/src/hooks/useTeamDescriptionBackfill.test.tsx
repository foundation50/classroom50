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
vi.mock("@/github-core/mutations", () => ({
  reconcileStudentTeamDescription: (...args: unknown[]) => reconcile(...args),
  // The real ClassroomSourceReadError (a plain Error subclass) so isPermanent's
  // `instanceof GitHubAPIError` check correctly treats it as transient.
  ClassroomSourceReadError: class ClassroomSourceReadError extends Error {
    readonly cause: unknown
    constructor(cause: unknown) {
      super("read classroom.json for team-description reconcile")
      this.name = "ClassroomSourceReadError"
      this.cause = cause
    }
  },
}))

import { useTeamDescriptionBackfill } from "./useTeamDescriptionBackfill"
import { ClassroomSourceReadError } from "@/github-core/mutations"
import { GitHubAPIError } from "@/github-core/errors"

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

describe("useTeamDescriptionBackfill", () => {
  it("does nothing when not enabled (non-owner viewer)", () => {
    renderHook(() => useTeamDescriptionBackfill("org", "cs101", false), {
      wrapper: wrapper(),
    })
    expect(reconcile).not.toHaveBeenCalled()
  })

  it("fires once per (org, classroom) with the classroom as a variable", async () => {
    reconcile.mockResolvedValue({ changed: false })
    renderHook(() => useTeamDescriptionBackfill("org", "cs101", true), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    // org/classroom are passed to the reconcile as arguments, not closed over.
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), "org", "cs101")
  })

  it("invalidates the my-teams cache only when the description changed", async () => {
    reconcile.mockResolvedValue({ changed: true, slug: "classroom50-cs101" })
    renderHook(() => useTeamDescriptionBackfill("org", "cs101", true), {
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

  it("does NOT invalidate when the description was already up to date", async () => {
    reconcile.mockResolvedValue({ changed: false })
    renderHook(() => useTeamDescriptionBackfill("org", "cs101", true), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(invalidateQueries).not.toHaveBeenCalled()
  })

  it("retries on re-entry after a transient failed run (key released)", async () => {
    reconcile.mockRejectedValueOnce(new Error("boom"))
    reconcile.mockResolvedValue({ changed: false })

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useTeamDescriptionBackfill("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    rerender({ classroom: "cs101" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3))
  })

  it("treats a classroom.json read miss as transient (releases the key)", async () => {
    // A ClassroomSourceReadError (classroom.json 404) must NOT latch — a fresh
    // config commit may still be propagating, so a later entry should retry.
    reconcile.mockRejectedValueOnce(
      new ClassroomSourceReadError(githubAPIError(404)),
    )
    reconcile.mockResolvedValue({ changed: false })

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useTeamDescriptionBackfill("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    rerender({ classroom: "cs101" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3))
  })

  it("does NOT re-fire after a permanent TEAM 404 (wrong slug never converges)", async () => {
    reconcile.mockRejectedValueOnce(githubAPIError(404))
    reconcile.mockResolvedValue({ changed: false })

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useTeamDescriptionBackfill("org", classroom, true),
      { wrapper: wrapper(), initialProps: { classroom: "cs101" } },
    )
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))
    rerender({ classroom: "cs202" })
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    rerender({ classroom: "cs101" })
    await new Promise((r) => setTimeout(r, 50))
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  it("does NOT re-fire after a permanent 403 the viewer can't fix", async () => {
    reconcile.mockRejectedValueOnce(githubAPIError(403))
    reconcile.mockResolvedValue({ changed: false })

    const { rerender } = renderHook(
      ({ classroom }: { classroom: string }) =>
        useTeamDescriptionBackfill("org", classroom, true),
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
