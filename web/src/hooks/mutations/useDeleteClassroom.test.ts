// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"

let deleteResult: { deleted: boolean; teamDeleteWarning?: boolean } = {
  deleted: true,
}
const deleteClassroom = vi.fn(() => Promise.resolve(deleteResult))

vi.mock("@/domain/classrooms", () => ({
  deleteClassroom: () => deleteClassroom(),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useDeleteClassroom } from "./useDeleteClassroom"

const ORG = "acme"
const SLUG = "cs101"
const listKey = githubKeys.jsonFile(ORG, CONFIG_REPO, "")

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  // Seed a cached dir listing so we can observe the optimistic drop.
  queryClient.setQueryData(listKey, [
    { path: SLUG, type: "dir" },
    { path: "other", type: "dir" },
  ])
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const { result } = renderHook(() => useDeleteClassroom(ORG, SLUG), {
    wrapper,
  })
  return { queryClient, result }
}

beforeEach(() => {
  deleteResult = { deleted: true }
  deleteClassroom.mockClear()
})

describe("useDeleteClassroom", () => {
  it("optimistically drops the deleted dir from the cached listing on success", async () => {
    const { queryClient, result } = setup()

    result.current.mutate({ org: ORG, classroom: SLUG })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const list = queryClient.getQueryData(listKey) as { path: string }[]
    expect(list.map((e) => e.path)).toEqual(["other"])
  })

  it("does NOT drop from the listing on a no-op deletion (deleted:false)", async () => {
    deleteResult = { deleted: false }
    const { queryClient, result } = setup()

    result.current.mutate({ org: ORG, classroom: SLUG })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const list = queryClient.getQueryData(listKey) as { path: string }[]
    expect(list.map((e) => e.path)).toEqual([SLUG, "other"])
  })

  it("invalidates the config-repo list key on settle", async () => {
    const { queryClient, result } = setup()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    result.current.mutate({ org: ORG, classroom: SLUG })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(ORG, CONFIG_REPO),
    })
  })
})
