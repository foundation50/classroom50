// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import type { TeamsFile } from "@/domain/teams/teamsFile"

const WRITTEN: TeamsFile = {
  schema: "classroom50/teams/v1",
  assignments: { hw1: { teams: [] } },
}

const saveTeamsSnapshot = vi.fn(async () => WRITTEN)
const syncTeamsSnapshot = vi.fn(async () => WRITTEN)
const writeTeamsFile = vi.fn(async () => WRITTEN)
vi.mock("@/domain/teams/teamsFile", () => ({
  saveTeamsSnapshot: (...a: unknown[]) => saveTeamsSnapshot(...(a as [])),
  syncTeamsSnapshot: (...a: unknown[]) => syncTeamsSnapshot(...(a as [])),
  writeTeamsFile: (...a: unknown[]) => writeTeamsFile(...(a as [])),
  removeTeamFromSnapshot: (file: TeamsFile) => file,
}))
const deleteGroupTeam = vi.fn(async () => undefined)
vi.mock("@/domain/teams/groupTeams", () => ({
  deleteGroupTeam: (...a: unknown[]) => deleteGroupTeam(...(a as [])),
}))
const applyGroupsPlan = vi.fn<() => Promise<unknown>>(async () => ({
  created: [{ key: "k", slug: "t" }],
  memberWarnings: [],
  teamsFile: WRITTEN,
}))
vi.mock("@/domain/teams/copyGroupsPlan", () => ({
  applyGroupsPlan: (...a: unknown[]) => applyGroupsPlan(...(a as [])),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import {
  useSaveTeamsSnapshot,
  useSyncTeamsSnapshot,
} from "./useSaveTeamsSnapshot"
import { useDeleteGroupTeam } from "./useDeleteGroupTeam"
import { useApplyGroupsPlan } from "./useApplyGroupsPlan"

const params = { org: "acme", classroom: "cs101", assignment: "hw1" }
const teamsKey = githubKeys.teamsFile("acme", "cs101")

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

// The committed teams.json lands in the cache as-is and the key is never
// invalidated, so a stale contents read can't become the drift baseline.
function expectSeededNotRefetched(s: ReturnType<typeof setup>) {
  expect(s.queryClient.getQueryData(teamsKey)).toEqual(WRITTEN)
  expect(s.queryClient.getQueryState(teamsKey)?.isInvalidated).toBe(false)
  expect(s.cancel).toHaveBeenCalledWith({ queryKey: teamsKey })
  expect(s.invalidate).not.toHaveBeenCalledWith(
    expect.objectContaining({ queryKey: teamsKey }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useSaveTeamsSnapshot", () => {
  it("seeds teams.json with the committed file", async () => {
    const s = setup(() => useSaveTeamsSnapshot(params))
    s.result.current.mutate({ teams: [] })
    await waitFor(() => expect(s.result.current.isSuccess).toBe(true))
    expectSeededNotRefetched(s)
  })
})

describe("useSyncTeamsSnapshot", () => {
  it("seeds teams.json with the committed file", async () => {
    const s = setup(() => useSyncTeamsSnapshot(params))
    s.result.current.mutate({ formation: "teacher" })
    await waitFor(() => expect(s.result.current.isSuccess).toBe(true))
    expectSeededNotRefetched(s)
  })
})

describe("useDeleteGroupTeam", () => {
  it("seeds teams.json when the snapshot cleanup committed", async () => {
    const s = setup(() => useDeleteGroupTeam(params))
    s.result.current.mutate({ slug: "classroom50-group-1", id: 1 })
    await waitFor(() => expect(s.result.current.isSuccess).toBe(true))
    expect(deleteGroupTeam).toHaveBeenCalledTimes(1)
    expectSeededNotRefetched(s)
  })

  // The team is gone either way; a failed cleanup leaves the old row on disk,
  // so the cache must be refetched rather than seeded with a guess.
  it("falls back to invalidating teams.json when the cleanup failed", async () => {
    writeTeamsFile.mockRejectedValueOnce(new Error("409"))
    const s = setup(() => useDeleteGroupTeam(params))
    s.result.current.mutate({ slug: "classroom50-group-1", id: 1 })
    await waitFor(() => expect(s.result.current.isSuccess).toBe(true))
    expect(s.queryClient.getQueryData(teamsKey)).toBeUndefined()
    expect(s.invalidate).toHaveBeenCalledWith({ queryKey: teamsKey })
  })
})

describe("useApplyGroupsPlan", () => {
  const input = { plan: [], formation: "teacher" as const, creatorLogin: "t" }

  it("seeds teams.json from the closing sync", async () => {
    const s = setup(() => useApplyGroupsPlan(params))
    s.result.current.mutate(input)
    await waitFor(() => expect(s.result.current.isSuccess).toBe(true))
    expectSeededNotRefetched(s)
  })

  it("falls back to invalidating teams.json when the apply carried no file", async () => {
    applyGroupsPlan.mockResolvedValueOnce({ created: [], memberWarnings: [] })
    const s = setup(() => useApplyGroupsPlan(params))
    s.result.current.mutate(input)
    await waitFor(() => expect(s.result.current.isSuccess).toBe(true))
    expect(s.queryClient.getQueryData(teamsKey)).toBeUndefined()
    expect(s.invalidate).toHaveBeenCalledWith({ queryKey: teamsKey })
  })

  it("falls back to invalidating teams.json when the apply threw", async () => {
    applyGroupsPlan.mockRejectedValueOnce(new Error("boom"))
    const s = setup(() => useApplyGroupsPlan(params))
    s.result.current.mutate(input)
    await waitFor(() => expect(s.result.current.isError).toBe(true))
    expect(s.invalidate).toHaveBeenCalledWith({ queryKey: teamsKey })
  })
})
