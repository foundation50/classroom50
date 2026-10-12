// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import type { AssignmentsFile } from "@/domain/queries/assignments"

const WRITTEN: AssignmentsFile = {
  assignments: [{ slug: "hw1", name: "HW1" }],
} as AssignmentsFile

const copyAssignments = vi.fn<(input: unknown) => Promise<unknown>>(
  async () => ({ outcomes: [], newCommitSha: "c", assignments: WRITTEN }),
)
const deleteAssignments = vi.fn<(input: unknown) => Promise<unknown>>(
  async () => ({
    deleted: ["hw2"],
    missing: [],
    newCommitSha: "d",
    assignments: WRITTEN,
  }),
)
const setAssignmentsLock = vi.fn<(input: unknown) => Promise<unknown>>(
  async () => ({
    changed: ["hw1"],
    missing: [],
    outcomes: [],
    newCommitSha: "l",
    assignments: WRITTEN,
  }),
)
vi.mock("@/domain/assignments", () => ({
  copyAssignmentsWithConflictRetry: (_client: unknown, input: unknown) =>
    copyAssignments(input),
  deleteAssignmentsWithConflictRetry: (_client: unknown, input: unknown) =>
    deleteAssignments(input),
  setAssignmentsLockWithConflictRetry: (_client: unknown, input: unknown) =>
    setAssignmentsLock(input),
}))

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useCanAttemptTemplateGrant: () => false,
}))

import {
  useBulkDeleteAssignments,
  useBulkReuseAssignments,
  useBulkSetAssignmentLock,
} from "./useBulkAssignmentActions"
import type { Assignment } from "@/types/classroom"

const items = [{ source: { slug: "hw1" } as Assignment, targetSlug: "hw1-2" }]
const assignmentsKey = githubKeys.assignmentsFile("acme", "cs101")

function setup<T>(useHook: () => T) {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, "invalidateQueries")
  const cancel = vi.spyOn(queryClient, "cancelQueries")
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return {
    queryClient,
    invalidate,
    cancel,
    ...renderHook(useHook, { wrapper }),
  }
}

// The committed file lands in the cache as-is; the raw key is never
// invalidated, so a stale contents read can't overwrite it (#1004).
function expectSeededNotRefetched(s: ReturnType<typeof setup>) {
  expect(s.queryClient.getQueryData(assignmentsKey)).toEqual(WRITTEN)
  expect(s.queryClient.getQueryState(assignmentsKey)?.isInvalidated).toBe(false)
  expect(s.cancel).toHaveBeenCalledWith({ queryKey: assignmentsKey })
  expect(s.invalidate).not.toHaveBeenCalledWith(
    expect.objectContaining({ queryKey: assignmentsKey }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useBulkReuseAssignments", () => {
  // The write is one commit to the TARGET classroom, so that is the file whose
  // cache is seeded, not the source's.
  it("seeds the target classroom's assignments.json with the committed file", async () => {
    const s = setup(() => useBulkReuseAssignments("acme"))

    s.result.current.mutate({ items, targetClassroom: "cs101" })

    await waitFor(() => expect(s.result.current.isSuccess).toBe(true))
    expect(copyAssignments).toHaveBeenCalledWith(
      expect.objectContaining({ targetClassroom: "cs101", items }),
    )
    expectSeededNotRefetched(s)
  })

  // KeepTabOpenGuard reads the flag off the mutation cache: one commit plus a
  // grant per copy is a multi-write the teacher should not lose mid-run.
  it("declares keepTabOpen on the mutation", async () => {
    const s = setup(() => useBulkReuseAssignments("acme"))
    s.result.current.mutate({ items, targetClassroom: "cs101" })
    await waitFor(() => expect(s.result.current.isSuccess).toBe(true))
    const [mutation] = s.queryClient.getMutationCache().getAll()
    expect(mutation.options.meta).toEqual({ keepTabOpen: true })
  })
})

describe("useBulkSetAssignmentLock", () => {
  it("seeds assignments.json with the committed file", async () => {
    const s = setup(() => useBulkSetAssignmentLock("acme", "cs101"))

    s.result.current.mutate({ slugs: ["hw1"], locked: true })

    await waitFor(() => expect(s.result.current.isSuccess).toBe(true))
    expect(setAssignmentsLock).toHaveBeenCalledWith({
      org: "acme",
      classroom: "cs101",
      slugs: ["hw1"],
      locked: true,
    })
    expectSeededNotRefetched(s)
  })
})

describe("useBulkDeleteAssignments", () => {
  it("seeds assignments.json with the committed file", async () => {
    const s = setup(() => useBulkDeleteAssignments("acme", "cs101"))

    s.result.current.mutate({ slugs: ["hw2"] })

    await waitFor(() => expect(s.result.current.isSuccess).toBe(true))
    expect(deleteAssignments).toHaveBeenCalledWith({
      org: "acme",
      classroom: "cs101",
      slugs: ["hw2"],
    })
    expectSeededNotRefetched(s)
  })
})
