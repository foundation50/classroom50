// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import type { ConcernId } from "@/orgPolicy/audit"

const renameConfigRepoToMain = vi.fn<(...args: unknown[]) => Promise<void>>(
  () => Promise.resolve(),
)
const removeUserFromTeam = vi.fn<(...args: unknown[]) => Promise<void>>(() =>
  Promise.resolve(),
)
const cancelOrgInvitation = vi.fn<(...args: unknown[]) => Promise<void>>(() =>
  Promise.resolve(),
)
const repairConcern = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({}),
)
const initClassroom50 = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({ status: "ok" }),
)
const syncRosterAfterStaffChange = vi.fn<(...args: unknown[]) => void>(() => {})

vi.mock("@/github-core/mutations", () => ({
  renameConfigRepoToMain: (client: unknown, org: unknown) =>
    renameConfigRepoToMain(client, org),
  removeUserFromTeam: (client: unknown, input: unknown) =>
    removeUserFromTeam(client, input),
  cancelOrgInvitation: (client: unknown, input: unknown) =>
    cancelOrgInvitation(client, input),
  initClassroom50: (params: unknown) => initClassroom50(params),
}))
vi.mock("@/orgPolicy/repair", () => ({
  repairConcern: (client: unknown, org: unknown, id: unknown, plan: unknown) =>
    repairConcern(client, org, id, plan),
}))
vi.mock("@/hooks/mutations/useAddStaffMember", () => ({
  syncRosterAfterStaffChange: (...a: unknown[]) =>
    syncRosterAfterStaffChange(...a),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useRenameConfigRepoToMain } from "./useRenameConfigRepoToMain"
import { useRemoveStaffMember } from "./useRemoveStaffMember"
import { useCancelStaffInvite } from "./useCancelStaffInvite"
import { useRepairOrgPolicyConcern } from "./useRepairOrgPolicyConcern"
import { useRunOrgSetup } from "./useRunOrgSetup"

const ORG = "acme"
const CLASSROOM = "cs101"
const TEAM = "classroom50-cs101-ta"

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

describe("useRenameConfigRepoToMain", () => {
  it("renames then invalidates the org-audit prefix", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useRenameConfigRepoToMain(ORG), {
      wrapper: wrapperWith(queryClient),
    })
    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(renameConfigRepoToMain).toHaveBeenCalledWith(expect.anything(), ORG)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.orgAuditPrefix(ORG),
    })
  })
})

describe("useRemoveStaffMember", () => {
  it("removes the user, invalidates team members + invitations, and syncs the roster", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(
      () => useRemoveStaffMember(ORG, CLASSROOM, TEAM),
      { wrapper: wrapperWith(queryClient) },
    )
    result.current.mutate("alice")
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(removeUserFromTeam).toHaveBeenCalledWith(expect.anything(), {
      org: ORG,
      teamSlug: TEAM,
      username: "alice",
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.teamMembers(ORG, TEAM),
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.teamInvitations(ORG, TEAM),
    })
    expect(syncRosterAfterStaffChange).toHaveBeenCalled()
  })
})

describe("useCancelStaffInvite", () => {
  it("cancels the invite and invalidates the bound team's queries", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useCancelStaffInvite(ORG, TEAM), {
      wrapper: wrapperWith(queryClient),
    })
    result.current.mutate(99)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(cancelOrgInvitation).toHaveBeenCalledWith(expect.anything(), {
      org: ORG,
      invitationId: 99,
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.teamInvitations(ORG, TEAM),
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.teamMembers(ORG, TEAM),
    })
  })
})

describe("useRepairOrgPolicyConcern", () => {
  it("repairs the concern, runs onRepaired, and invalidates the org-audit prefix", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const onRepaired = vi.fn()
    const { result } = renderHook(
      () => useRepairOrgPolicyConcern(ORG, "Team", onRepaired),
      { wrapper: wrapperWith(queryClient) },
    )
    const concernId: ConcernId = "orgDefaults"
    result.current.mutate(concernId)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(repairConcern).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      concernId,
      "Team",
    )
    // onRepaired (durable persist) runs in the hook, unmount-safe.
    expect(onRepaired).toHaveBeenCalledWith({}, concernId)
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.orgAuditPrefix(ORG),
    })
  })
})

describe("useRunOrgSetup", () => {
  it("delegates to initClassroom50 and runs the caller's invalidate in the hook (unmount-safe)", async () => {
    const queryClient = freshClient()
    const onStepUpdate = vi.fn()
    const confirmSkeletonOverwrite = vi.fn()
    const invalidate = vi.fn()
    const { result } = renderHook(
      () =>
        useRunOrgSetup({
          org: ORG,
          plan: "Team",
          onStepUpdate,
          confirmSkeletonOverwrite,
          invalidate,
        }),
      { wrapper: wrapperWith(queryClient) },
    )
    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(initClassroom50).toHaveBeenCalledWith(
      expect.objectContaining({ org: ORG, plan: "Team", onStepUpdate }),
    )
    // Invalidation runs in the hook's onSuccess (fires regardless of caller
    // unmount), receiving the queryClient + init result.
    expect(invalidate).toHaveBeenCalledWith(queryClient, { status: "ok" })
  })
})
