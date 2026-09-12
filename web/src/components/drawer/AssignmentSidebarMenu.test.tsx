// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

// A protected classroom publishes its manifest under `<classroom>/<secret>/`.
// The student sidebar reads that manifest to learn the assignment's mode
// (team vs individual) and whether to offer Accept. Regression: for a team
// assignment the group repo is named after the team counter, so the
// individual-repo .classroom50.yaml can never supply the secret; the student
// team's bootstrap record must be consulted first, or the sidebar misreads the
// mode and offers Accept to a student whose group already has a repo.

vi.mock("@/context/classroomRole/ClassroomRoleProvider", () => ({
  useClassroomRoleContext: () => ({
    role: "student",
    actualRole: "student",
    roleResolved: true,
    isLoading: false,
    isError: false,
    retry: () => {},
  }),
}))
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => (
      <a href={to} data-to={to}>
        {children}
      </a>
    ),
    useMatchRoute: () => () => false,
  }
})
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "alice" } }),
}))
vi.mock("@/hooks/useGetClassroom", () => ({
  default: () => ({ data: undefined }),
}))

let teamSecret: string | undefined
vi.mock("@/hooks/useStudentClassrooms", () => ({
  useClassroomSecret: () => ({
    secret: teamSecret,
    pagesBaseUrl: undefined,
    isLoading: false,
  }),
}))

let repoSecrets: Record<string, string | undefined> = {}
const dotClassroom50Spy = vi.fn()
vi.mock("@/hooks/useDotClassroom50", () => ({
  default: (org: string, repo: string) => {
    dotClassroom50Spy(org, repo)
    return { secret: repo ? repoSecrets[repo] : undefined }
  },
}))

// The published manifest is reachable only with the right secret.
const PAGES_SECRET = "pagessecret"
let publishedMode: "individual" | "team" = "individual"
const pagesAssignmentsSpy = vi.fn()
vi.mock("@/hooks/usePagesAssignments", () => ({
  default: (
    _org: string,
    _classroom: string,
    secret: string | undefined,
    options: { assignmentSlug?: string },
  ) => {
    pagesAssignmentsSpy(secret)
    const unlocked = secret === PAGES_SECRET
    const entry = unlocked
      ? { slug: options.assignmentSlug, mode: publishedMode }
      : undefined
    return {
      data: entry ? [entry] : undefined,
      assignment: entry,
      isLoading: false,
      isError: !unlocked,
    }
  },
}))

// The student is on group 1, and that group's repo exists; the individual-
// formula repo does not.
vi.mock("@/hooks/useMyGroupTeam", () => ({
  default: () => ({
    data: { slug: "classroom50-group-abc-1", id: 1, n: 1 },
    isLoading: false,
  }),
}))
vi.mock("@/hooks/useGetAssignmentRepo", () => ({
  default: (
    _org: string,
    _classroom: string,
    _assignment: string,
    owner: string | undefined,
  ) => ({
    assignment: owner === "group-1" ? { name: "cs101-hw1-group-1" } : undefined,
    isLoading: false,
  }),
}))

import { AssignmentSidebarMenu } from "./AssignmentSidebarMenu"

const renderMenu = () =>
  render(
    <AssignmentSidebarMenu org="acme" classroom="cs101" assignment="hw1" />,
  )

const hasAccept = () => screen.queryByText("nav.acceptAssignment") !== null

beforeEach(() => {
  teamSecret = undefined
  repoSecrets = {}
  publishedMode = "individual"
  dotClassroom50Spy.mockClear()
  pagesAssignmentsSpy.mockClear()
})

afterEach(cleanup)

describe("AssignmentSidebarMenu protected-classroom secret sourcing", () => {
  it("resolves a team assignment's group repo using the team record's secret", () => {
    teamSecret = PAGES_SECRET
    publishedMode = "team"
    renderMenu()
    expect(screen.getByText("nav.mySubmissionTeam")).toBeTruthy()
    expect(hasAccept()).toBe(false)
    expect(dotClassroom50Spy).not.toHaveBeenCalledWith(
      "acme",
      "cs101-hw1-alice",
    )
  })

  it("falls back to the individual repo's .classroom50.yaml when the record has no secret", () => {
    repoSecrets = { "cs101-hw1-alice": PAGES_SECRET }
    renderMenu()
    expect(dotClassroom50Spy).toHaveBeenCalledWith("acme", "cs101-hw1-alice")
    // The label alone can't prove the fallback worked (the non-team branch
    // renders it either way), so assert the secret reached the Pages read.
    expect(pagesAssignmentsSpy).toHaveBeenLastCalledWith(PAGES_SECRET)
    expect(screen.getByText("nav.mySubmission")).toBeTruthy()
  })
})
