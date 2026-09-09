// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

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
        href="https://example.test/link"
        data-to={to}
        data-params={JSON.stringify(params ?? {})}
        data-search={JSON.stringify(search ?? {})}
      >
        {children}
      </a>
    ),
  }
})

// RouterButton (createLink) needs a router context; stub it to the same
// data-attribute-carrying anchor as the Link mock above so the accept-link
// search assertion keeps working without a RouterProvider.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>()
  return {
    ...actual,
    RouterButton: ({
      children,
      to,
      params,
      search,
    }: {
      children?: React.ReactNode
      to?: string
      params?: Record<string, string>
      search?: Record<string, string>
    }) => (
      <a
        href="https://example.test/link"
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
const submittedAssignments = vi.fn()

vi.mock("@/hooks/usePagesAssignments", () => ({
  default: (...args: unknown[]) => pagesAssignments(...args),
}))
vi.mock("@/hooks/useGetMyOrgRepos", () => ({
  default: (...args: unknown[]) => orgRepos(...args),
}))
vi.mock("@/hooks/useMySubmittedAssignments", () => ({
  useMySubmittedAssignments: (...args: unknown[]) =>
    submittedAssignments(...args),
}))
vi.mock("@/hooks/useStudentClassrooms", () => ({
  useStudentClassrooms: () => studentClassrooms(),
  useClassroomSecret: (_org?: string, classroom?: string) => ({
    secret: studentClassrooms().classrooms.find(
      (c: { classroom: string; secret?: string }) => c.classroom === classroom,
    )?.secret,
    isLoading: false,
  }),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "student1" } }),
}))

import { StudentAssignmentList } from "./StudentAssignmentList"

// Fixtures default to a passed release date so the toolbar/sort/CTA specs
// exercise listed assignments; the hide-by-default spec overrides it.
const assignment = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  name: slug.toUpperCase(),
  mode: "individual",
  autograder: "default",
  available_from: "2020-01-01T00:00:00Z",
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
  submittedAssignments.mockReset()
  studentClassrooms.mockReturnValue({ classrooms: [{ classroom: "cs" }] })
  // Nothing submitted unless a spec says so.
  submittedAssignments.mockReturnValue({
    submittedSlugs: new Set(),
    isPending: false,
  })
  // View mode + sort persist in localStorage; clear so one test's toggle
  // doesn't bleed the stored view into another's default-view assertion.
  globalThis.localStorage?.clear()
})

afterEach(() => {
  cleanup()
  globalThis.localStorage?.clear()
})

describe("StudentAssignmentList", () => {
  it("lists all published assignments, accepted and not", () => {
    pagesAssignments.mockReturnValue({
      data: [assignment("hw1"), assignment("hw2")],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [repo("cs-hw1-student1")] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    expect(screen.getByText("HW1")).toBeTruthy()
    expect(screen.getByText("HW2")).toBeTruthy()
    // hw1 accepted -> "view submission"; hw2 not -> "accept".
    expect(screen.getByText("assignments.discover.viewSubmission")).toBeTruthy()
    expect(screen.getByText("assignments.discover.accept")).toBeTruthy()
    // The Status column: the accepted assignment reads "Accepted", the other
    // gets the red "Not accepted" badge.
    expect(
      screen.getAllByText("assignments.discover.notAccepted"),
    ).toHaveLength(1)
    expect(screen.getAllByText("assignments.discover.accepted")).toHaveLength(1)
  })

  it("shows Submitted once the accepted repo has a submission, reading the repo acceptance resolved", () => {
    pagesAssignments.mockReturnValue({
      data: [assignment("hw1"), assignment("hw2")],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [repo("cs-hw1-student1")] })
    submittedAssignments.mockReturnValue({
      submittedSlugs: new Set(["hw1"]),
      isPending: false,
    })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    // The submission read is scoped to exactly the accepted repos.
    expect(submittedAssignments).toHaveBeenCalledWith("acme", [
      {
        assignment: expect.objectContaining({ slug: "hw1" }),
        repo: "cs-hw1-student1",
      },
    ])
    expect(screen.getAllByText("assignments.discover.submitted")).toHaveLength(
      1,
    )
    expect(screen.queryByText("assignments.discover.accepted")).toBeNull()
    expect(
      screen.getAllByText("assignments.discover.notAccepted"),
    ).toHaveLength(1)
    // Submitted still routes to the submission view, not back to accept.
    expect(screen.getByText("assignments.discover.viewSubmission")).toBeTruthy()
  })

  it("hands the group repo to the submission read for an accepted team assignment", () => {
    pagesAssignments.mockReturnValue({
      data: [assignment("hw1", { mode: "team" })],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [repo("cs-hw1-group-2")] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    expect(submittedAssignments).toHaveBeenCalledWith("acme", [
      {
        assignment: expect.objectContaining({ slug: "hw1" }),
        repo: "cs-hw1-group-2",
      },
    ])
  })

  it("keeps a past due date red only until the student submits", () => {
    pagesAssignments.mockReturnValue({
      data: [
        assignment("hw1", { name: "HW1", due: "2020-01-01" }),
        assignment("hw2", { name: "HW2", due: "2020-01-01" }),
      ],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({
      data: [repo("cs-hw1-student1"), repo("cs-hw2-student1")],
    })
    submittedAssignments.mockReturnValue({
      submittedSlugs: new Set(["hw1"]),
      isPending: false,
    })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    // Both accepted, so the only red badge left is the overdue deadline of the
    // row with nothing submitted; the submitted row shows its date as data.
    const submittedRow = screen.getByText("HW1").closest("tr")!
    const pendingRow = screen.getByText("HW2").closest("tr")!
    expect(submittedRow.querySelector(".badge-error")).toBeNull()
    expect(pendingRow.querySelector(".badge-error")).not.toBeNull()
  })

  it("holds the skeleton while the submission reads are still pending", () => {
    pagesAssignments.mockReturnValue({
      data: [assignment("hw1")],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [repo("cs-hw1-student1")] })
    submittedAssignments.mockReturnValue({
      submittedSlugs: new Set(),
      isPending: true,
    })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    // No row paints "Accepted" only to flip to "Submitted" a beat later.
    expect(screen.queryByText("HW1")).toBeNull()
    expect(screen.queryByText("assignments.discover.accepted")).toBeNull()
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

  it("shows the link-only guidance when published assignments are unreleased and not accepted", () => {
    // Hide-by-default: an assignment with no release date the student hasn't
    // accepted is off the list; surface the invite-link guidance, not the
    // filter-oriented "no results".
    pagesAssignments.mockReturnValue({
      data: [assignment("hw1", { available_from: undefined })],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    expect(screen.getByText("assignments.discover.linkOnlyTitle")).toBeTruthy()
    expect(screen.queryByText("HW1")).toBeNull()
  })

  it("always lists an assignment the student accepted, even with no release date", () => {
    pagesAssignments.mockReturnValue({
      data: [assignment("hw1", { available_from: undefined })],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [repo("cs-hw1-student1")] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    expect(screen.getByText("HW1")).toBeTruthy()
    expect(screen.getByText("assignments.discover.viewSubmission")).toBeTruthy()
  })

  it("shows the group-phrased CTA plus a View group action for an accepted team assignment", () => {
    // Team mode: acceptance derives from push access to the shared
    // `<classroom>-<slug>-group-<n>` repo, and the row's copy speaks for the
    // group, with the read-only members action alongside.
    pagesAssignments.mockReturnValue({
      data: [assignment("hw1", { mode: "team" })],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [repo("cs-hw1-group-1")] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    expect(
      screen.getByText("assignments.discover.viewSubmissionTeam"),
    ).toBeTruthy()
    expect(screen.getByText("assignments.discover.viewGroup")).toBeTruthy()
    expect(screen.queryByText("assignments.discover.viewSubmission")).toBeNull()
  })

  it("keeps the individual CTA and offers no View group action before a team accept", () => {
    pagesAssignments.mockReturnValue({
      data: [assignment("hw1", { mode: "team" })],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    expect(screen.getByText("assignments.discover.accept")).toBeTruthy()
    expect(screen.queryByText("assignments.discover.viewGroup")).toBeNull()
  })

  it("renders the toolbar and orders assignments due-soonest-first by default", () => {
    pagesAssignments.mockReturnValue({
      data: [
        assignment("late", { name: "Late", due: "2026-12-01" }),
        assignment("soon", { name: "Soon", due: "2026-06-15" }),
      ],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    // Toolbar present (search input by its aria label).
    expect(
      screen.getByLabelText("assignments.discover.toolbar.searchAria"),
    ).toBeTruthy()
    // Due-soonest-first: the "Soon" row's name link appears before "Late".
    const linkTexts = screen.getAllByRole("link").map((a) => a.textContent)
    expect(linkTexts.indexOf("Soon")).toBeLessThan(linkTexts.indexOf("Late"))
  })

  it("filters to accepted-only via the status control", () => {
    pagesAssignments.mockReturnValue({
      data: [
        assignment("hw1", { name: "HW1", due: "2026-06-15" }),
        assignment("hw2", { name: "HW2", due: "2026-07-15" }),
      ],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [repo("cs-hw1-student1")] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    fireEvent.change(
      screen.getByLabelText("assignments.discover.toolbar.statusAria"),
      { target: { value: "accepted" } },
    )

    expect(screen.getByText("HW1")).toBeTruthy()
    expect(screen.queryByText("HW2")).toBeNull()
  })

  it("filters to submitted-only via the status control, excluding accepted-but-unsubmitted", () => {
    pagesAssignments.mockReturnValue({
      data: [
        assignment("hw1", { name: "HW1", due: "2026-06-15" }),
        assignment("hw2", { name: "HW2", due: "2026-07-15" }),
        assignment("hw3", { name: "HW3", due: "2026-08-15" }),
      ],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({
      data: [repo("cs-hw1-student1"), repo("cs-hw2-student1")],
    })
    submittedAssignments.mockReturnValue({
      submittedSlugs: new Set(["hw1"]),
      isPending: false,
    })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    const status = screen.getByLabelText(
      "assignments.discover.toolbar.statusAria",
    )
    fireEvent.change(status, { target: { value: "submitted" } })
    expect(screen.getByText("HW1")).toBeTruthy()
    expect(screen.queryByText("HW2")).toBeNull()
    expect(screen.queryByText("HW3")).toBeNull()

    // "Accepted" means accepted with nothing in yet, matching its badge.
    fireEvent.change(status, { target: { value: "accepted" } })
    expect(screen.queryByText("HW1")).toBeNull()
    expect(screen.getByText("HW2")).toBeTruthy()
    expect(screen.queryByText("HW3")).toBeNull()
  })

  it("flips the due-date order from the sortable column header", () => {
    pagesAssignments.mockReturnValue({
      data: [
        assignment("late", { name: "Late", due: "2026-12-01" }),
        assignment("soon", { name: "Soon", due: "2026-06-15" }),
      ],
      isLoading: false,
      isError: false,
    })
    orgRepos.mockReturnValue({ data: [] })

    render(<StudentAssignmentList org="acme" classroom="cs" />)

    // Default due-asc puts "Soon" first; clicking the Due date header flips
    // to due-desc, putting "Late" first (in sync with the toolbar select).
    fireEvent.click(screen.getByTitle("assignments.table.sortByDue"))

    const linkTexts = screen.getAllByRole("link").map((a) => a.textContent)
    expect(linkTexts.indexOf("Late")).toBeLessThan(linkTexts.indexOf("Soon"))
  })
})
