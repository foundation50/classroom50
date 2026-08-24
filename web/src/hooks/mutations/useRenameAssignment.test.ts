// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import type { RenameProgress } from "@/domain/assignments"

const renameAssignment =
  vi.fn<
    (
      client: unknown,
      input: unknown,
      opts: { onProgress?: (p: RenameProgress) => void },
    ) => Promise<unknown>
  >()

vi.mock("@/domain/assignments", () => ({
  renameAssignment: (
    client: unknown,
    input: unknown,
    opts: { onProgress?: (p: RenameProgress) => void },
  ) => renameAssignment(client, input, opts),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useRenameAssignment } from "./useRenameAssignment"

const ORG = "acme"
const CLASSROOM = "cs101"
const INPUT = {
  org: ORG,
  classroom: CLASSROOM,
  oldSlug: "old-slug",
  newSlug: "ps3",
}

const summary = {
  mode: "fresh",
  results: [],
  failed: 0,
  lockReleased: true,
  lockRestoreFailed: false,
  prevLocked: false,
}

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function freshClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useRenameAssignment", () => {
  it("invalidates assignments.json, scores.json, and the org repo list on success", async () => {
    renameAssignment.mockResolvedValue(summary)
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useRenameAssignment(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate(INPUT)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(
        ORG,
        CONFIG_REPO,
        `${CLASSROOM}/assignments.json`,
      ),
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(
        ORG,
        CONFIG_REPO,
        `${CLASSROOM}/scores.json`,
      ),
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.orgRepos(ORG),
    })
    expect(renameAssignment).toHaveBeenCalledWith(
      expect.anything(),
      INPUT,
      expect.objectContaining({ onProgress: expect.any(Function) }),
    )
  })

  it("still invalidates on error — the config commit may have landed before the throw", async () => {
    renameAssignment.mockRejectedValue(new Error("boom"))
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useRenameAssignment(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate(INPUT)
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(
        ORG,
        CONFIG_REPO,
        `${CLASSROOM}/assignments.json`,
      ),
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.orgRepos(ORG),
    })
  })

  it("exposes fan-out progress from the domain callback", async () => {
    renameAssignment.mockImplementation(
      async (
        _client: unknown,
        _input: unknown,
        opts: { onProgress?: (p: RenameProgress) => void },
      ) => {
        opts.onProgress?.({ processed: 1, total: 3, repo: "cs101-ps3-alice" })
        return summary
      },
    )
    const queryClient = freshClient()
    const { result } = renderHook(() => useRenameAssignment(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate(INPUT)
    await waitFor(() =>
      expect(result.current.progress).toEqual({
        processed: 1,
        total: 3,
        repo: "cs101-ps3-alice",
      }),
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })
})
