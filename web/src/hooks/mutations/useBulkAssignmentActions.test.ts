// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"

const copyAssignments = vi.fn(async (_input: unknown) => ({
  outcomes: [],
  newCommitSha: "c",
}))
vi.mock("@/domain/assignments", () => ({
  copyAssignmentsWithConflictRetry: (_client: unknown, input: unknown) =>
    copyAssignments(input),
  deleteAssignmentsWithConflictRetry: vi.fn(),
  setAssignmentsLockWithConflictRetry: vi.fn(),
}))

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useCanAttemptTemplateGrant: () => false,
}))

import { useBulkReuseAssignments } from "./useBulkAssignmentActions"
import type { Assignment } from "@/types/classroom"

const items = [{ source: { slug: "hw1" } as Assignment, targetSlug: "hw1-2" }]

function setup() {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return {
    queryClient,
    ...renderHook(() => useBulkReuseAssignments("acme"), { wrapper }),
  }
}

describe("useBulkReuseAssignments", () => {
  // The write is one commit to the TARGET classroom, so that is the file whose
  // cache goes stale, not the source's.
  it("invalidates the target classroom's assignments after the commit", async () => {
    const { result, queryClient } = setup()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    result.current.mutate({ items, targetClassroom: "cs101" })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(copyAssignments).toHaveBeenCalledWith(
      expect.objectContaining({ targetClassroom: "cs101", items }),
    )
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(
        "acme",
        CONFIG_REPO,
        "cs101/assignments.json",
      ),
    })
  })

  // KeepTabOpenGuard reads the flag off the mutation cache: one commit plus a
  // grant per copy is a multi-write the teacher should not lose mid-run.
  it("declares keepTabOpen on the mutation", async () => {
    const { result, queryClient } = setup()
    result.current.mutate({ items, targetClassroom: "cs101" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const [mutation] = queryClient.getMutationCache().getAll()
    expect(mutation.options.meta).toEqual({ keepTabOpen: true })
  })
})
