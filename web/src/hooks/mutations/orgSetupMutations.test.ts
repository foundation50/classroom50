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
const getUser = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({ id: 4242 }),
)
const resendClassroomInvite = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  () => Promise.resolve({ state: "invited" }),
)
const removeClassroomStaffMember = vi.fn<
  (...args: unknown[]) => Promise<unknown>
>(() => Promise.resolve())

vi.mock("@/github-core/mutations", () => ({
  renameConfigRepoToMain: (client: unknown, org: unknown) =>
    renameConfigRepoToMain(client, org),
  cancelOrgInvitation: (client: unknown, input: unknown) =>
    cancelOrgInvitation(client, input),
  initClassroom50: (params: unknown) => initClassroom50(params),
}))
vi.mock("@/github-core/queries", async (importOriginal) => ({
  // Keep the real githubKeys (assertions build query keys from it); override
  // only the network read the resend hook performs.
  ...(await importOriginal<typeof import("@/github-core/queries")>()),
  getUser: (client: unknown, login: unknown) => getUser(client, login),
}))
vi.mock("@/domain/students", () => ({
  resendClassroomInvite: (...a: unknown[]) => resendClassroomInvite(...a),
  removeClassroomStaffMember: (...a: unknown[]) =>
    removeClassroomStaffMember(...a),
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
import { useResendStaffInvite } from "./useResendStaffInvite"
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
  it("delegates to removeClassroomStaffMember, invalidates members + invitations, and syncs the roster", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(
      () => useRemoveStaffMember(ORG, CLASSROOM, TEAM, "ta"),
      { wrapper: wrapperWith(queryClient) },
    )
    result.current.mutate("alice")
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(removeClassroomStaffMember).toHaveBeenCalledWith(expect.anything(), {
      org: ORG,
      teamSlug: TEAM,
      username: "alice",
      role: "ta",
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

describe("useResendStaffInvite", () => {
  const ROLE = "ta" as const

  it("resolves invitee id + team, resends carrying the team, and invalidates", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(
      () => useResendStaffInvite(ORG, CLASSROOM, ROLE, TEAM),
      { wrapper: wrapperWith(queryClient) },
    )
    result.current.mutate({
      login: "bob",
      invitationId: 12,
      emailOnlyMessage: "EMAIL_ONLY",
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(getUser).toHaveBeenCalledWith(expect.anything(), "bob")
    expect(resendClassroomInvite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        org: ORG,
        classroom: CLASSROOM,
        username: "bob",
        inviteeId: 4242,
        invitationId: 12,
        role: ROLE,
      }),
    )
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.teamInvitations(ORG, TEAM),
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.teamMembers(ORG, TEAM),
    })
  })

  it("throws the caller-supplied emailOnlyMessage when login is null (t()-free)", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(
      () => useResendStaffInvite(ORG, CLASSROOM, ROLE, TEAM),
      { wrapper: wrapperWith(queryClient) },
    )
    result.current.mutate({
      login: null,
      invitationId: 12,
      emailOnlyMessage: "EMAIL_ONLY",
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe("EMAIL_ONLY")
    // The email-only guard short-circuits before any network read.
    expect(getUser).not.toHaveBeenCalled()
    expect(resendClassroomInvite).not.toHaveBeenCalled()
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

  it("does not run onRepaired or invalidate when the repair rejects", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const onRepaired = vi.fn()
    repairConcern.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(
      () => useRepairOrgPolicyConcern(ORG, "Team", onRepaired),
      { wrapper: wrapperWith(queryClient) },
    )
    result.current.mutate("orgDefaults" as ConcernId)
    await waitFor(() => expect(result.current.isError).toBe(true))
    // onSuccess never fires on rejection, so neither the durable persist nor
    // the audit invalidation runs.
    expect(onRepaired).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalledWith({
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

  it("skips initClassroom50 on the org-absent path but still runs invalidate", async () => {
    const queryClient = freshClient()
    const invalidate = vi.fn()
    const { result } = renderHook(
      () =>
        useRunOrgSetup({
          org: undefined,
          plan: "Team",
          onStepUpdate: vi.fn(),
          invalidate,
        }),
      { wrapper: wrapperWith(queryClient) },
    )
    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // Matches the pre-refactor early return: no init call, undefined result.
    expect(initClassroom50).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith(queryClient, undefined)
  })

  it("supports a caller invalidate that guards on result.status (RerunOrgSetup shape)", async () => {
    // RerunOrgSetup passes an invalidate that skips on a status-"error"
    // outcome; OrgSetupPage's is unconditional. Exercise the guarded shape's
    // both branches directly against the callback the hook drives.
    const queryClient = freshClient()
    const doInvalidate = vi.spyOn(queryClient, "invalidateQueries")
    const guardedInvalidate = (
      qc: typeof queryClient,
      result: { status?: string } | undefined,
    ) => {
      if (result && result.status === "error") return
      qc.invalidateQueries({ queryKey: githubKeys.orgAuditPrefix(ORG) })
      qc.invalidateQueries({ queryKey: ["orgs"] })
    }

    initClassroom50.mockResolvedValueOnce({ status: "error" })
    const errRun = renderHook(
      () =>
        useRunOrgSetup({
          org: ORG,
          onStepUpdate: vi.fn(),
          invalidate: guardedInvalidate,
        }),
      { wrapper: wrapperWith(queryClient) },
    )
    errRun.result.current.mutate()
    await waitFor(() => expect(errRun.result.current.isSuccess).toBe(true))
    expect(doInvalidate).not.toHaveBeenCalled()

    initClassroom50.mockResolvedValueOnce({ status: "ok" })
    const okRun = renderHook(
      () =>
        useRunOrgSetup({
          org: ORG,
          onStepUpdate: vi.fn(),
          invalidate: guardedInvalidate,
        }),
      { wrapper: wrapperWith(queryClient) },
    )
    okRun.result.current.mutate()
    await waitFor(() => expect(okRun.result.current.isSuccess).toBe(true))
    expect(doInvalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.orgAuditPrefix(ORG),
    })
    expect(doInvalidate).toHaveBeenCalledWith({ queryKey: ["orgs"] })
  })
})
