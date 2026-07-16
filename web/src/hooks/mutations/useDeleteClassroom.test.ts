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
const classroomKey = githubKeys.jsonFile(
  ORG,
  CONFIG_REPO,
  `${SLUG}/classroom.json`,
)

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

  it("does NOT invalidate the optimistically-edited listing key on a real deletion", async () => {
    // The optimistic drop is authoritative; re-invalidating the listing key we
    // just edited would refetch GitHub's read-after-write-eventual Contents API
    // and could re-add the just-deleted dir (a flicker).
    const { result } = setup()
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries")

    result.current.mutate({ org: ORG, classroom: SLUG })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: listKey })
    invalidate.mockRestore()
  })

  it("evicts the deleted classroom's own config query on a real deletion", async () => {
    const { queryClient, result } = setup()
    // Seed the per-classroom config read so we can observe its removal.
    queryClient.setQueryData(classroomKey, { short_name: SLUG, active: true })

    result.current.mutate({ org: ORG, classroom: SLUG })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(queryClient.getQueryData(classroomKey)).toBeUndefined()
  })

  it("invalidates the listing key on a no-op deletion to reconcile", async () => {
    deleteResult = { deleted: false }
    const { queryClient, result } = setup()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    result.current.mutate({ org: ORG, classroom: SLUG })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: listKey })
  })

  it("returns teamDeleteWarning to the call site on a real deletion", async () => {
    deleteResult = { deleted: true, teamDeleteWarning: true }
    const { result } = setup()

    result.current.mutate({ org: ORG, classroom: SLUG })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual({
      deleted: true,
      teamDeleteWarning: true,
    })
  })
})
