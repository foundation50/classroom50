// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"
import type { Student } from "@/types/classroom"

const enrollStudentInClassroom =
  vi.fn<(...args: unknown[]) => Promise<unknown>>()

vi.mock("@/domain/students", () => ({
  enrollStudentInClassroom: (...a: unknown[]) => enrollStudentInClassroom(...a),
  inviteByEmail: vi.fn(),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/hooks/useTeamRoster", () => ({
  useInvalidateTeamRoster: () => vi.fn(),
  useSeedTeamMember: () => vi.fn(),
}))
vi.mock("@/hooks/useIdentityDirectory", () => ({
  useResolveEmailRows: () => vi.fn(),
}))

import { useEnrollOrInviteStudent } from "./useEnrollOrInviteStudent"

const ORG = "acme"
const CLASSROOM = "cs101"
const ROSTER_KEY = githubKeys.rosterFile(ORG, CLASSROOM)

const row = (over: Partial<Student>): Student => ({
  username: "",
  first_name: "",
  last_name: "",
  email: "",
  section: "",
  github_id: "",
  role: "",
  ...over,
})

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

async function enroll(
  queryClient: QueryClient,
  domainResult: Record<string, unknown>,
) {
  enrollStudentInClassroom.mockResolvedValue(domainResult)
  const { result } = renderHook(
    () => useEnrollOrInviteStudent(ORG, CLASSROOM),
    { wrapper: wrapperWith(queryClient) },
  )
  result.current.mutate({
    first_name: "",
    last_name: "",
    username: "ada",
    email: "",
    section: "",
  })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  return queryClient.getQueryData<Student[]>(ROSTER_KEY)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// The optimistic roster patch (see useUpdateRosterCache): a completed row is
// swapped in place of the row it replaced, keyed by that row's pre-write
// studentKey; anything else is appended.
describe("useEnrollOrInviteStudent — roster cache patch", () => {
  const completed = row({ username: "ada", github_id: "42", first_name: "Ada" })

  it("replaces the completed row in place by its pre-write key", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData<Student[]>(ROSTER_KEY, [
      row({ github_id: "42", first_name: "Ada" }),
      row({ username: "bob", github_id: "7" }),
    ])

    const cached = await enroll(queryClient, {
      student: completed,
      completedRow: { key: "42", label: "Ada" },
      enrolled: false,
    })

    expect(cached?.map((s) => s.username)).toEqual(["ada", "bob"])
  })

  it("replaces a username-keyed row whose key changes once the id is filled", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData<Student[]>(ROSTER_KEY, [row({ username: "Ada" })])

    const cached = await enroll(queryClient, {
      student: completed,
      completedRow: { key: "Ada", label: "Ada" },
      enrolled: false,
    })

    expect(cached).toEqual([completed])
  })

  it("appends when the replaced row is missing from the cache, and on a plain add", async () => {
    const stale = new QueryClient()
    stale.setQueryData<Student[]>(ROSTER_KEY, [row({ username: "bob" })])
    const afterMiss = await enroll(stale, {
      student: completed,
      completedRow: { key: "42", label: "Ada" },
      enrolled: false,
    })
    expect(afterMiss?.map((s) => s.username)).toEqual(["bob", "ada"])

    const plain = new QueryClient()
    plain.setQueryData<Student[]>(ROSTER_KEY, [row({ username: "bob" })])
    const afterAdd = await enroll(plain, {
      student: completed,
      enrolled: false,
    })
    expect(afterAdd?.map((s) => s.username)).toEqual(["bob", "ada"])
  })
})
