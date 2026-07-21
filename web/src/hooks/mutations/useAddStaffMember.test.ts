// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"

const addClassroomStaffMember = vi.fn<(...args: unknown[]) => Promise<unknown>>(
  () => Promise.resolve({ username: "bob", role: "ta" }),
)
// syncRosterAfterStaffChange (in the hook module) calls syncRosterFromTeam;
// stub it so the best-effort roster sync is a no-op in the test.
const syncRosterFromTeam = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({}),
)

vi.mock("@/domain/students", () => ({
  addClassroomStaffMember: (...a: unknown[]) => addClassroomStaffMember(...a),
  syncRosterFromTeam: (...a: unknown[]) => syncRosterFromTeam(...a),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useAddStaffMember } from "./useAddStaffMember"

const ORG = "acme"
const CLASSROOM = "cs101"

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

describe("useAddStaffMember", () => {
  const messages = { enterUsername: "ENTER_USERNAME" }

  it("delegates to addClassroomStaffMember and invalidates the role team's members + invitations", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(
      () => useAddStaffMember(ORG, CLASSROOM, messages),
      { wrapper: wrapperWith(queryClient) },
    )
    result.current.mutate({ username: "bob", role: "ta" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(addClassroomStaffMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        org: ORG,
        classroom: CLASSROOM,
        username: "bob",
        role: "ta",
      }),
    )
    const teamSlug = "classroom50-cs101-ta"
    // Both lists refresh: a non-member add lands as a pending invite, not a
    // member (the invitations invalidation is the issue #348 fix).
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.teamMembers(ORG, teamSlug),
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.teamInvitations(ORG, teamSlug),
    })
    // Call site's success toast reads `trimmed`.
    expect(result.current.data).toEqual({ trimmed: "bob", role: "ta" })
  })

  it("throws the caller-supplied enterUsername message on blank input (no domain call)", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(
      () => useAddStaffMember(ORG, CLASSROOM, messages),
      { wrapper: wrapperWith(queryClient) },
    )
    result.current.mutate({ username: "   ", role: "ta" })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe("ENTER_USERNAME")
    expect(addClassroomStaffMember).not.toHaveBeenCalled()
  })
})
