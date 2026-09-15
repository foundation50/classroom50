// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"

// The assignments.json each write reports as committed. The hooks must seed
// the read cache with exactly this (never refetch it: GitHub's contents API is
// read-after-write eventual, #1004).
const WRITTEN_ASSIGNMENTS = {
  schema: "classroom50/assignments/v1",
  assignments: [{ slug: "hw1", name: "HW1 (saved)" }],
}
const WRITTEN_CLASSROOM = { short_name: "cs101", name: "CS 101 (saved)" }

const createClassroomFilesWithConflictRetry = vi.fn<
  (...args: unknown[]) => Promise<unknown>
>(() => Promise.resolve({ newCommitSha: "sha-c" }))
const editClassroomWithConflictRetry = vi.fn<
  (...args: unknown[]) => Promise<unknown>
>(() =>
  Promise.resolve({
    newCommitSha: "sha-e",
    classroom: WRITTEN_CLASSROOM,
    teamDescription: { changed: false },
  }),
)
const createAssignment = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
  Promise.resolve({ newCommitSha: "sha-a", assignments: WRITTEN_ASSIGNMENTS }),
)
const editAssignmentWithConflictRetry = vi.fn<
  (...args: unknown[]) => Promise<unknown>
>(() =>
  Promise.resolve({ newCommitSha: "sha-ea", assignments: WRITTEN_ASSIGNMENTS }),
)
const setAssignmentLockWithConflictRetry = vi.fn<
  (...args: unknown[]) => Promise<unknown>
>(() =>
  Promise.resolve({
    newCommitSha: "sha-l",
    locked: true,
    assignments: WRITTEN_ASSIGNMENTS,
  }),
)
const setAssignmentClosedWithConflictRetry = vi.fn<
  (...args: unknown[]) => Promise<unknown>
>(() =>
  Promise.resolve({
    newCommitSha: "sha-x",
    closed: true,
    assignments: WRITTEN_ASSIGNMENTS,
  }),
)

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
  setAssignmentLockWithConflictRetry: (client: unknown, input: unknown) =>
    setAssignmentLockWithConflictRetry(client, input),
  setAssignmentClosedWithConflictRetry: (client: unknown, input: unknown) =>
    setAssignmentClosedWithConflictRetry(client, input),
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
import { useSetAssignmentLock } from "./useSetAssignmentLock"
import { useSetAssignmentClosed } from "./useSetAssignmentClosed"

const ORG = "acme"
const CLASSROOM = "cs101"
const assignmentsKey = githubKeys.jsonFile(
  ORG,
  CONFIG_REPO,
  `${CLASSROOM}/assignments.json`,
)
const classroomKey = githubKeys.jsonFile(
  ORG,
  CONFIG_REPO,
  `${CLASSROOM}/classroom.json`,
)

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function freshClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } })
}

// The raw contents key must be seeded (cancel, then set) and never invalidated,
// which would refetch and race the eventual contents API.
function expectSeededNotRefetched(
  queryClient: QueryClient,
  spies: {
    invalidate: ReturnType<typeof vi.spyOn>
    cancel: ReturnType<typeof vi.spyOn>
  },
  key: readonly unknown[],
  document: unknown,
) {
  expect(queryClient.getQueryData(key)).toEqual(document)
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false)
  expect(spies.cancel).toHaveBeenCalledWith({ queryKey: key })
  expect(spies.invalidate).not.toHaveBeenCalledWith(
    expect.objectContaining({ queryKey: key }),
  )
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
  it("seeds the exact classroom.json with the committed record, invalidates only the listing, then forwards onWrite", async () => {
    const queryClient = freshClient()
    // A stale pre-write body in the cache: the seed must replace it.
    queryClient.setQueryData(classroomKey, {
      short_name: CLASSROOM,
      name: "old",
    })
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const onWrite = vi.fn()
    const { result } = renderHook(
      () => useEditClassroom(ORG, CLASSROOM, onWrite),
      { wrapper: wrapperWith(queryClient) },
    )

    result.current.mutate({ slug: CLASSROOM, org: ORG } as never)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expectSeededNotRefetched(
      queryClient,
      { invalidate, cancel },
      classroomKey,
      WRITTEN_CLASSROOM,
    )
    // The classes listing is a different query, safe to refetch.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(ORG, CONFIG_REPO),
    })
    // An unchanged team description leaves the student enumeration cache alone.
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: githubKeys.myTeams(),
    })
    expect(editClassroomWithConflictRetry).toHaveBeenCalledWith(
      expect.anything(),
      { slug: CLASSROOM, org: ORG },
    )
    expect(onWrite).toHaveBeenCalledWith({
      newCommitSha: "sha-e",
      classroom: WRITTEN_CLASSROOM,
      teamDescription: { changed: false },
    })
  })

  it("invalidates my-teams when the edit rewrote the team description", async () => {
    // A rename re-projects the classroom50/team/v1 record onto the student
    // team; GET /user/teams must refresh so a teacher previewing as a student
    // sees the new name.
    editClassroomWithConflictRetry.mockResolvedValueOnce({
      newCommitSha: "sha-e",
      classroom: WRITTEN_CLASSROOM,
      teamDescription: { changed: true, slug: "classroom50-cs101" },
    })
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useEditClassroom(ORG, CLASSROOM), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({
      slug: CLASSROOM,
      org: ORG,
      name: "Renamed",
    } as never)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.myTeams(),
    })
  })
})

describe("useCreateAssignment", () => {
  it("seeds assignments.json with the committed file and forwards onWrite", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const onWrite = vi.fn()
    const { result } = renderHook(
      () => useCreateAssignment(ORG, CLASSROOM, onWrite),
      { wrapper: wrapperWith(queryClient) },
    )

    result.current.mutate({ slug: "hw1", name: "HW1" } as never)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expectSeededNotRefetched(
      queryClient,
      { invalidate, cancel },
      assignmentsKey,
      WRITTEN_ASSIGNMENTS,
    )
    expect(createAssignment).toHaveBeenCalledWith(expect.anything(), {
      slug: "hw1",
      name: "HW1",
      canGrantTemplateAccess: true,
    })
    expect(onWrite).toHaveBeenCalledWith(
      { newCommitSha: "sha-a", assignments: WRITTEN_ASSIGNMENTS },
      { slug: "hw1", name: "HW1" },
    )
  })
})

describe("useEditAssignment", () => {
  it("seeds assignments.json with the committed file, forwards onWrite, and delegates to the domain write", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const onWrite = vi.fn()
    const { result } = renderHook(() => useEditAssignment({ onWrite }), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({
      slug: "hw1",
      name: "HW1",
      org: ORG,
      classroom: CLASSROOM,
    } as never)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(editAssignmentWithConflictRetry).toHaveBeenCalledWith(
      expect.anything(),
      {
        slug: "hw1",
        name: "HW1",
        org: ORG,
        classroom: CLASSROOM,
        canGrantTemplateAccess: true,
      },
    )
    expect(onWrite).toHaveBeenCalledWith(
      { newCommitSha: "sha-ea", assignments: WRITTEN_ASSIGNMENTS },
      { slug: "hw1", name: "HW1", org: ORG, classroom: CLASSROOM },
    )
    expectSeededNotRefetched(
      queryClient,
      { invalidate, cancel },
      assignmentsKey,
      WRITTEN_ASSIGNMENTS,
    )
  })

  it("runs the hook-level onMutate before the write settles", async () => {
    const queryClient = freshClient()
    const onMutate = vi.fn()
    // A deferred write so we can observe state while it is still pending —
    // proving onMutate is hook-level (fired pre-flight) rather than only that
    // it eventually ran.
    let resolveWrite!: (value: {
      newCommitSha: string
      assignments: unknown
    }) => void
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

    resolveWrite({ newCommitSha: "sha-ea", assignments: WRITTEN_ASSIGNMENTS })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })
})

describe("useSetAssignmentLock", () => {
  it("seeds assignments.json with the committed file and forwards onWrite", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const onWrite = vi.fn()
    const { result } = renderHook(
      () => useSetAssignmentLock(ORG, CLASSROOM, onWrite),
      { wrapper: wrapperWith(queryClient) },
    )

    const input = { org: ORG, classroom: CLASSROOM, slug: "hw1", locked: true }
    result.current.mutate(input)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expectSeededNotRefetched(
      queryClient,
      { invalidate, cancel },
      assignmentsKey,
      WRITTEN_ASSIGNMENTS,
    )
    expect(setAssignmentLockWithConflictRetry).toHaveBeenCalledWith(
      expect.anything(),
      input,
    )
    expect(onWrite).toHaveBeenCalledWith(
      expect.objectContaining({ locked: true }),
      input,
    )
  })
})

describe("useSetAssignmentClosed", () => {
  it("seeds assignments.json with the committed file and forwards onWrite", async () => {
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const onWrite = vi.fn()
    const { result } = renderHook(
      () => useSetAssignmentClosed(ORG, CLASSROOM, onWrite),
      { wrapper: wrapperWith(queryClient) },
    )

    const input = { org: ORG, classroom: CLASSROOM, slug: "hw1", closed: true }
    result.current.mutate(input)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expectSeededNotRefetched(
      queryClient,
      { invalidate, cancel },
      assignmentsKey,
      WRITTEN_ASSIGNMENTS,
    )
    expect(setAssignmentClosedWithConflictRetry).toHaveBeenCalledWith(
      expect.anything(),
      input,
    )
    expect(onWrite).toHaveBeenCalledWith(
      expect.objectContaining({ closed: true }),
      input,
    )
  })
})
