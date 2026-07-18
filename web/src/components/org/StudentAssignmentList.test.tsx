// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

// TanStack Link -> a plain anchor exposing its resolved params/search so the
// test can assert the accept CTA threads the capability secret as ?k.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({
      children,
      to,
      params,
      search,
    }: {
      children: React.ReactNode
      to: string
      params?: Record<string, string>
      search?: Record<string, string>
    }) => (
      <a
        data-to={to}
        data-params={JSON.stringify(params ?? {})}
        data-search={JSON.stringify(search ?? {})}
      >
        {children}
      </a>
    ),
  }
})

const pagesAssignments = vi.fn()
const orgRepos = vi.fn()
const studentClassrooms = vi.fn()

vi.mock("@/hooks/usePagesAssignments", () => ({
  default: (...args: unknown[]) => pagesAssignments(...args),
}))
vi.mock("@/hooks/useGetMyOrgRepos", () => ({
  default: (...args: unknown[]) => orgRepos(...args),
}))
vi.mock("@/hooks/useStudentClassrooms", () => ({
  useStudentClassrooms: () => studentClassrooms(),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "student1" } }),
}))

import { StudentAssignmentList } from "./StudentAssignmentList"

const assignment = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  name: slug.toUpperCase(),
  mode: "individual",
  autograder: "default",
  ...over,
})

const repo = (name: string, push = true) => ({
  id: name,
  name,
  full_name: `acme/${name}`,
  permissions: { push, pull: true, admin: false, maintain: false },
})

beforeEach(() => {
  pagesAssignments.mockReset()
  orgRepos.mockReset()
  studentClassrooms.mockReset()
  studentClassrooms.mockReturnValue({ classrooms: [{ classroom: "cs" }] })
})

afterEach(cleanup)

describe("StudentAssignmentList", () => {
  it("lists all published assignments, accepted and not", () => {
    pagesAssignments.mockReturnValue({
      data: [assignment("hw1"), assignment("hw2")],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [repo("cs-hw1-student1")] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    expect(screen.getByRole("heading", { name: "HW1" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "HW2" })).toBeTruthy()
    // hw1 accepted -> "view submission"; hw2 not -> "accept".
    expect(screen.getByText("assignments.discover.viewSubmission")).toBeTruthy()
    expect(screen.getByText("assignments.discover.accept")).toBeTruthy()
  })

  it("threads the capability secret into the accept link", () => {
    studentClassrooms.mockReturnValue({
      classrooms: [{ classroom: "cs", secret: "a1b2c3d4" }],
    })
    pagesAssignments.mockReturnValue({
      data: [assignment("hw2")],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    const acceptLink = screen
      .getByText("assignments.discover.accept")
      .closest("a")
    expect(acceptLink?.getAttribute("data-search")).toContain("a1b2c3d4")
  })

  it("shows the invite-link fallback when the Pages read errors (protected, no secret)", () => {
    pagesAssignments.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    })
    orgRepos.mockReturnValue({ data: [] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    expect(
      screen.getByText("assignments.discover.protectedNoSecret"),
    ).toBeTruthy()
  })

  it("shows the empty state when the classroom has no published assignments", () => {
    pagesAssignments.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    expect(screen.getByText("assignments.discover.emptyTitle")).toBeTruthy()
  })
})
