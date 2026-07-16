// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"

// Domain/github-core writes are mocked so each hook test asserts only the
// hook's own responsibility: that it delegates to the right fn and (where it
// owns cache reconcile) invalidates the right keys.
const cancelOrgInvitation = vi.fn<(...args: unknown[]) => Promise<void>>(() =>
  Promise.resolve(),
)
const acceptAssignment = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({ status: "created", repo: {}, cloneCommand: "" }),
)
const deleteAssignment = vi.fn<(...args: unknown[]) => Promise<void>>(() =>
  Promise.resolve(),
)
const unenrollStudent = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({ removed: true }),
)
const updateStudentWithConflictRetry = vi.fn<
  (...args: unknown[]) => Promise<unknown>
>(() => Promise.resolve({ student: {} }))
const invalidateInviteQueries = vi.fn<(...args: unknown[]) => void>(() => {})

vi.mock("@/github-core/mutations", () => ({
  cancelOrgInvitation: (client: unknown, input: unknown) =>
    cancelOrgInvitation(client, input),
}))
vi.mock("@/domain/assignments", () => ({
  acceptAssignment: (params: unknown) => acceptAssignment(params),
  deleteAssignment: (client: unknown, input: unknown) =>
    deleteAssignment(client, input),
}))
vi.mock("@/domain/students", () => ({
  unenrollStudent: (client: unknown, input: unknown) =>
    unenrollStudent(client, input),
  updateStudentWithConflictRetry: (client: unknown, input: unknown) =>
    updateStudentWithConflictRetry(client, input),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
// invalidateInviteQueries is a real re-export from the queries barrel; spy it
// but keep githubKeys intact (the accept test asserts a real key).
vi.mock("@/github-core/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/github-core/queries")>()
  return {
    ...actual,
    invalidateInviteQueries: (queryClient: unknown, org: unknown) =>
      invalidateInviteQueries(queryClient, org),
  }
})

import { useDismissFailedInvite } from "./useDismissFailedInvite"
import { useAcceptAssignment } from "./useAcceptAssignment"
import { useDeleteAssignment } from "./useDeleteAssignment"
import { useUnenrollStudent } from "./useUnenrollStudent"
import { useUpdateStudent } from "./useUpdateStudent"

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

describe("useDismissFailedInvite", () => {
  it("cancels the invite and invalidates the invite queries on success", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(() => useDismissFailedInvite(ORG), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate(42)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(cancelOrgInvitation).toHaveBeenCalledWith(expect.anything(), {
      org: ORG,
      invitationId: 42,
    })
    expect(invalidateInviteQueries).toHaveBeenCalledWith(queryClient, ORG)
  })
})

describe("useAcceptAssignment", () => {
  it("accepts and invalidates the org-repos query on success", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const onStepUpdate = vi.fn()
    const { result } = renderHook(
      () =>
        useAcceptAssignment({
          org: ORG,
          classroom: CLASSROOM,
          assignmentSlug: "hw1",
          onStepUpdate,
        }),
      { wrapper: wrapperWith(queryClient) },
    )

    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(acceptAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        org: ORG,
        classroom: CLASSROOM,
        assignmentSlug: "hw1",
        onStepUpdate,
      }),
    )
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: githubKeys.orgRepos(ORG) }),
    )
  })
})

describe("thin passthrough hooks delegate to their domain fn", () => {
  it("useDeleteAssignment delegates the input", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(() => useDeleteAssignment(), {
      wrapper: wrapperWith(queryClient),
    })
    const input = { org: ORG, classroom: CLASSROOM, assignment: "hw1" }
    result.current.mutate(input)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(deleteAssignment).toHaveBeenCalledWith(expect.anything(), input)
  })

  it("useUnenrollStudent binds org/classroom and passes the student", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(() => useUnenrollStudent(ORG, CLASSROOM), {
      wrapper: wrapperWith(queryClient),
    })
    const student = { username: "alice" } as never
    result.current.mutate(student)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(unenrollStudent).toHaveBeenCalledWith(expect.anything(), {
      org: ORG,
      classroom: CLASSROOM,
      student,
    })
  })

  it("useUpdateStudent delegates the full input", async () => {
    const queryClient = freshClient()
    const { result } = renderHook(() => useUpdateStudent(), {
      wrapper: wrapperWith(queryClient),
    })
    const input = {
      org: ORG,
      classroom: CLASSROOM,
      key: "id:1",
      patch: { first_name: "A", last_name: "B", email: "", section: "" },
    } as never
    result.current.mutate(input)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(updateStudentWithConflictRetry).toHaveBeenCalledWith(
      expect.anything(),
      input,
    )
  })
})
