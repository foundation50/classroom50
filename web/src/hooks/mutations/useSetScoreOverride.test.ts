// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"

// The scores.json the write reports as committed. The hook must seed the raw
// scores read with exactly this and never refetch it: GitHub's contents API is
// read-after-write eventual, so a refetch could pin the pre-override body for
// the read's staleTime and make the override look like it snapped back (#1004).
const WRITTEN_SCORES = {
  schema: "classroom50/scores/v1",
  assignments: {
    hw1: {
      type: "individual",
      entries: [{ owner: "alice", override: true, submissions: [] }],
    },
  },
}

const editScoreOverride = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({ newCommitSha: "sha-s", scores: WRITTEN_SCORES }),
)

vi.mock("@/domain/assignments/scoreOverride", () => ({
  editScoreOverride: (client: unknown, input: unknown) =>
    editScoreOverride(client, input),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useSetScoreOverride } from "./useSetScoreOverride"

const ORG = "acme"
const CLASSROOM = "cs101"
const scoresKey = githubKeys.jsonFile(
  ORG,
  CONFIG_REPO,
  `${CLASSROOM}/scores.json`,
)

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useSetScoreOverride", () => {
  it("seeds the raw scores.json with the committed file instead of refetching it, then forwards onWrite", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    queryClient.setQueryData(scoresKey, {
      schema: "classroom50/scores/v1",
      assignments: {},
    })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const onWrite = vi.fn()
    const { result } = renderHook(() => useSetScoreOverride({ onWrite }), {
      wrapper: wrapperWith(queryClient),
    })

    const input = {
      org: ORG,
      classroom: CLASSROOM,
      assignment: "hw1",
      owner: "alice",
      assignmentType: "individual" as const,
      score: 9,
      maxPoints: 10,
    }
    result.current.mutate(input)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(editScoreOverride).toHaveBeenCalledWith(expect.anything(), input)
    expect(queryClient.getQueryData(scoresKey)).toEqual(WRITTEN_SCORES)
    expect(queryClient.getQueryState(scoresKey)?.isInvalidated).toBe(false)
    // Cancel-then-seed: a slow in-flight read can't land on top of the seed.
    expect(cancel).toHaveBeenCalledWith({ queryKey: scoresKey })
    expect(invalidate).not.toHaveBeenCalled()
    expect(onWrite).toHaveBeenCalledWith(
      { newCommitSha: "sha-s", scores: WRITTEN_SCORES },
      input,
    )
  })
})
