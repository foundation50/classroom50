// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"

// Capture the options passed to useMutation so we can assert the serialization
// scope without depending on mutation timing.
let lastMutationScopeId: string | undefined
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>()
  return {
    ...actual,
    useMutation: ((options: Parameters<typeof actual.useMutation>[0]) => {
      lastMutationScopeId = options.scope?.id
      return actual.useMutation(options)
    }) as typeof actual.useMutation,
  }
})

// Drives editClassroomWithConflictRetry; switchable to fail so we can assert the
// optimistic flip rolls back.
let editShouldFail = false
const editClassroom = vi.fn((_client: unknown, input: { active?: boolean }) => {
  if (editShouldFail) return Promise.reject(new Error("boom"))
  return Promise.resolve(input)
})

vi.mock("@/domain/classrooms", () => ({
  editClassroomWithConflictRetry: (client: unknown, input: unknown) =>
    editClassroom(client, input as { active?: boolean }),
}))

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useArchiveClassroom } from "./useArchiveClassroom"

const ORG = "acme"
const SLUG = "cs101"
const classroomKey = githubKeys.jsonFile(
  ORG,
  CONFIG_REPO,
  `${SLUG}/classroom.json`,
)

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  // Seed the cached classroom.json so we can observe the optimistic flip.
  queryClient.setQueryData(classroomKey, { short_name: SLUG, active: true })
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const { result } = renderHook(() => useArchiveClassroom(ORG, SLUG), {
    wrapper,
  })
  return { queryClient, result }
}

beforeEach(() => {
  editShouldFail = false
  editClassroom.mockClear()
})

describe("useArchiveClassroom", () => {
  it("optimistically flips the cached active on mutate and keeps it on success", async () => {
    const { queryClient, result } = setup()

    result.current.mutate(false)

    // Optimistic flip is applied synchronously in onMutate.
    await waitFor(() =>
      expect(
        (queryClient.getQueryData(classroomKey) as { active: boolean }).active,
      ).toBe(false),
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(editClassroom).toHaveBeenCalledWith(expect.anything(), {
      org: ORG,
      slug: SLUG,
      active: false,
    })
    // Stays flipped after success (no clobbering invalidate on the exact key).
    expect(
      (queryClient.getQueryData(classroomKey) as { active: boolean }).active,
    ).toBe(false)
  })

  it("rolls back the optimistic flip when the write fails", async () => {
    editShouldFail = true
    const { queryClient, result } = setup()

    result.current.mutate(false)

    await waitFor(() => expect(result.current.isError).toBe(true))
    // Rolled back to the pre-mutate snapshot.
    expect(
      (queryClient.getQueryData(classroomKey) as { active: boolean }).active,
    ).toBe(true)
  })

  it("invalidates the config-repo list key on settle", async () => {
    const { queryClient, result } = setup()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    result.current.mutate(false)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.jsonFile(ORG, CONFIG_REPO),
    })
  })

  it("cancels in-flight reads of the classroom.json key before flipping", async () => {
    // The flicker fix: a late read of classroom.json must be cancelled so it
    // can't resolve after and overwrite the optimistic flip.
    const { queryClient, result } = setup()
    const cancel = vi.spyOn(queryClient, "cancelQueries")

    result.current.mutate(false)
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(cancel).toHaveBeenCalledWith({ queryKey: classroomKey })
  })

  it("scopes the mutation per classroom so concurrent toggles serialize", () => {
    // A shared scope id makes React Query run same-classroom toggles one at a
    // time, so a second toggle's onMutate snapshot can't capture the first's
    // optimistic value (the stale-rollback race).
    setup()
    expect(lastMutationScopeId).toBe(`archive-classroom:${ORG}:${SLUG}`)
  })
})
