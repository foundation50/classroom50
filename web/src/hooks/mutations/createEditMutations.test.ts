// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"

const createClassroomFilesWithConflictRetry = vi.fn<
  (...args: unknown[]) => Promise<unknown>
>(() => Promise.resolve({ newCommitSha: "sha-c" }))
const editClassroomWithConflictRetry = vi.fn<
  (...args: unknown[]) => Promise<unknown>
>(() => Promise.resolve({ newCommitSha: "sha-e" }))
const createAssignment = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({ newCommitSha: "sha-a" }),
)
const editAssignmentWithConflictRetry = vi.fn<
  (...args: unknown[]) => Promise<unknown>
>(() => Promise.resolve({ newCommitSha: "sha-ea" }))

vi.mock("@/domain/classrooms", () => ({
  createClassroomFilesWithConflictRetry: (client: unknown, input: unknown) =>
    createClassroomFilesWithConflictRetry(client, input),
  editClassroomWithConflictRetry: (client: unknown, input: unknown) =>
    editClassroomWithConflictRetry(client, input),
}))
vi.mock("@/domain/assignments", () => ({
  createAssignment: (client: unknown, input: unknown) =>
    createAssignment(client, input),
  editAssignmentWithConflictRetry: (client: unknown, input: unknown) =>
    editAssignmentWithConflictRetry(client, input),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
// The assignment mutation hooks inject canGrantTemplateAccess from the org-role
// verdict; mock it deterministically (attemptable) so the forwarded-input
// assertions are stable.
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useIsOrgOwner: () => ({
    isOwner: true,
    isPending: false,
    isError: false,
    retry: vi.fn(),
  }),
  useCanAttemptTemplateGrant: () => true,
}))

import { useCreateClassroom } from "./useCreateClassroom"
import { useEditClassroom } from "./useEditClassroom"
import { useCreateAssignment } from "./useCreateAssignment"
import { useEditAssignment } from "./useEditAssignment"

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

describe("useCreateClassroom", () => {
  it("invalidates the config-repo listing and forwards onWrite", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const onWrite = vi.fn()
    const { result } = renderHook(() => useCreateClassroom(ORG, onWrite), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ classroom: CLASSROOM } as never)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(ORG, CONFIG_REPO),
    })
    expect(createClassroomFilesWithConflictRetry).toHaveBeenCalledWith(
      expect.anything(),
      { classroom: CLASSROOM },
    )
    expect(onWrite).toHaveBeenCalledWith(
      { newCommitSha: "sha-c" },
      { classroom: CLASSROOM },
    )
  })
})

describe("useEditClassroom", () => {
  it("invalidates the exact classroom.json AND the listing, then forwards onWrite", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const onWrite = vi.fn()
    const { result } = renderHook(
      () => useEditClassroom(ORG, CLASSROOM, onWrite),
      { wrapper: wrapperWith(queryClient) },
    )

    result.current.mutate({ slug: CLASSROOM, org: ORG } as never)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(
        ORG,
        CONFIG_REPO,
        `${CLASSROOM}/classroom.json`,
      ),
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(ORG, CONFIG_REPO),
    })
    expect(editClassroomWithConflictRetry).toHaveBeenCalledWith(
      expect.anything(),
      { slug: CLASSROOM, org: ORG },
    )
    expect(onWrite).toHaveBeenCalledWith({ newCommitSha: "sha-e" })
  })
})

describe("useCreateAssignment", () => {
  it("invalidates the assignments.json listing and forwards onWrite", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const onWrite = vi.fn()
    const { result } = renderHook(
      () => useCreateAssignment(ORG, CLASSROOM, onWrite),
      { wrapper: wrapperWith(queryClient) },
    )

    result.current.mutate({ slug: "hw1", name: "HW1" } as never)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(
        ORG,
        CONFIG_REPO,
        `${CLASSROOM}/assignments.json`,
      ),
    })
    expect(createAssignment).toHaveBeenCalledWith(expect.anything(), {
      slug: "hw1",
      name: "HW1",
      canGrantTemplateAccess: true,
    })
    expect(onWrite).toHaveBeenCalledWith(
      { newCommitSha: "sha-a" },
      { slug: "hw1", name: "HW1" },
    )
  })
})

describe("useEditAssignment", () => {
  it("forwards onWrite and delegates to the domain write, but does NOT invalidate (edit path relies on its own refetch)", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const onWrite = vi.fn()
    const { result } = renderHook(() => useEditAssignment({ onWrite }), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ slug: "hw1", name: "HW1" } as never)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(editAssignmentWithConflictRetry).toHaveBeenCalledWith(
      expect.anything(),
      { slug: "hw1", name: "HW1", canGrantTemplateAccess: true },
    )
    expect(onWrite).toHaveBeenCalledWith(
      { newCommitSha: "sha-ea" },
      { slug: "hw1", name: "HW1" },
    )
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("runs the hook-level onMutate before the write settles", async () => {
    const queryClient = freshClient()
    const onMutate = vi.fn()
    // A deferred write so we can observe state while it is still pending —
    // proving onMutate is hook-level (fired pre-flight) rather than only that
    // it eventually ran.
    let resolveWrite!: (value: { newCommitSha: string }) => void
    editAssignmentWithConflictRetry.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve
        }),
    )
    const { result } = renderHook(() => useEditAssignment({ onMutate }), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({ slug: "hw1", name: "HW1" } as never)

    // onMutate fired while the write is still unresolved.
    await waitFor(() => expect(onMutate).toHaveBeenCalled())
    expect(result.current.isPending).toBe(true)
    expect(onMutate.mock.invocationCallOrder[0]).toBeLessThan(
      editAssignmentWithConflictRetry.mock.invocationCallOrder[0],
    )

    resolveWrite({ newCommitSha: "sha-ea" })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })
})
