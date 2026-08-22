// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

import type { Assignment } from "@/types/classroom"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children }: { children?: ReactNode }) => (
      <a href="/mock">{children}</a>
    ),
    useNavigate: () => () => {},
  }
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

// The modal is exercised in its own test; here we stub it to a marker so the
// table test asserts only that the trigger renders and opens it.
vi.mock("@/components/modals/TemplateAccessModal", () => ({
  TemplateAccessModal: ({ assignment }: { assignment: { slug: string } }) => (
    <div data-testid="template-access-modal">{assignment.slug}</div>
  ),
}))

const scores = vi.fn()
vi.mock("@/hooks/useGetScores", () => ({
  default: (...a: unknown[]) => scores(...a),
}))

const orgRepos = vi.fn()
vi.mock("@/hooks/useGetMyOrgRepos", () => ({
  default: (...a: unknown[]) => orgRepos(...a),
}))

import AssignmentsTable from "./AssignmentsTable"

const wrap = (ui: ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const assignment = (over: Partial<Assignment> = {}): Assignment =>
  ({ slug: "hw1", name: "HW 1", mode: "individual", ...over }) as Assignment

const inOrgTemplate = { owner: "acme", repo: "tmpl", branch: "main" }
const ACCESS_ARIA = "assignments.template.accessModal.triggerAria"

// The submission cell renders "<submitted> / <denominator>" as sibling text
// nodes; read the row's textContent to assert the rendered ratio.
const ratioText = () =>
  screen.getByText("assignments.table.colSubmissions").closest("table")
    ?.textContent ?? ""

beforeEach(() => {
  scores.mockReset()
  scores.mockReturnValue({ data: { submissions: {} } })
  orgRepos.mockReset()
  orgRepos.mockReturnValue({ data: [], isPending: false })
})

afterEach(cleanup)

describe("AssignmentsTable submission denominator", () => {
  it("uses the student-role count as the denominator, not roster rows", () => {
    scores.mockReturnValue({ data: { submissions: { hw1: [{}, {}, {}] } } })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={11}
      />,
    )
    // 3 submitted out of 11 students (not the 14 roster rows).
    expect(ratioText()).toContain("3 / 11")
  })

  it("clamps so a non-student submission can't push the ratio above 100%", () => {
    // 5 submission repos but only 3 student-role members: display clamps to 3/3.
    scores.mockReturnValue({
      data: { submissions: { hw1: [{}, {}, {}, {}, {}] } },
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={3}
      />,
    )
    expect(ratioText()).toContain("3 / 3")
    expect(ratioText()).not.toContain("5 / 3")
  })

  it("renders 0 / 0 without dividing by zero when there are no students", () => {
    scores.mockReturnValue({ data: { submissions: { hw1: [{}] } } })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={0}
      />,
    )
    expect(ratioText()).toContain("0 / 0")
  })

  it("leaves group assignments as a submitted count, no roster denominator", () => {
    scores.mockReturnValue({ data: { submissions: { hw1: [{}, {}] } } })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ mode: "group" })]}
        studentCount={11}
      />,
    )
    expect(ratioText()).toContain("assignments.table.groupsSubmitted")
    expect(ratioText()).not.toContain("/ 11")
  })
})

describe("AssignmentsTable — Template access button", () => {
  it("renders the trigger for an in-org templated assignment", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ template: inOrgTemplate })]}
        studentCount={0}
      />,
    )
    expect(screen.queryByLabelText(ACCESS_ARIA)).toBeTruthy()
  })

  it("renders the trigger for an out-of-org template too (review + link)", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[
          assignment({ template: { ...inOrgTemplate, owner: "other" } }),
        ]}
        studentCount={0}
      />,
    )
    expect(screen.queryByLabelText(ACCESS_ARIA)).toBeTruthy()
  })

  it("does not render it for a template-less assignment", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={0}
      />,
    )
    expect(screen.queryByLabelText(ACCESS_ARIA)).toBeNull()
  })

  it("still renders it when archived (viewing stays available)", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ template: inOrgTemplate })]}
        studentCount={0}
        archived
      />,
    )
    expect(screen.queryByLabelText(ACCESS_ARIA)).toBeTruthy()
  })

  it("opens the template-access modal on click", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ template: inOrgTemplate })]}
        studentCount={0}
      />,
    )
    expect(screen.queryByTestId("template-access-modal")).toBeNull()
    fireEvent.click(screen.getByLabelText(ACCESS_ARIA))
    expect(screen.getByTestId("template-access-modal").textContent).toBe("hw1")
  })
})

describe("AssignmentsTable — Release date column", () => {
  it("shows the link-only badge when no release date is set", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={0}
      />,
    )
    expect(screen.getByText("assignments.table.releaseNotSet")).toBeTruthy()
  })

  it("shows the scheduled badge when the release date is in the future", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ available_from: "2999-01-01T00:00:00Z" })]}
        studentCount={0}
      />,
    )
    expect(screen.getByText("assignments.table.scheduled")).toBeTruthy()
    expect(screen.queryByText("assignments.table.releaseNotSet")).toBeNull()
  })

  it("shows the released date (no link-only/scheduled badge) once it has passed", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ available_from: "2020-01-01T00:00:00Z" })]}
        studentCount={0}
      />,
    )
    expect(screen.queryByText("assignments.table.releaseNotSet")).toBeNull()
    expect(screen.queryByText("assignments.table.scheduled")).toBeNull()
  })
})

// An assignment that skips grading has a permanently empty scores.json bucket
// (collect_scores.py skips it), so the ratio would read 0/N forever (#659). The
// cell reports repo presence and defers the real count to the submissions page.
describe("AssignmentsTable — assignments that skip grading", () => {
  const repo = (name: string) => ({ id: name.length, name })

  it("shows repo presence instead of a permanently-zero ratio", () => {
    orgRepos.mockReturnValue({
      data: [repo("cs101-hw1-alice"), repo("cs101-hw1-bob")],
      isPending: false,
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ no_autograder: true })]}
        studentCount={2}
      />,
    )
    expect(screen.getByText("assignments.table.reposAccepted")).toBeTruthy()
    // The misleading fraction and its graded-progress bar are both gone.
    expect(ratioText()).not.toContain("0 / 2")
    expect(document.querySelector("progress")).toBeNull()
  })

  it("shows the no-repos label when nothing has been accepted", () => {
    orgRepos.mockReturnValue({ data: [], isPending: false })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ no_autograder: true })]}
        studentCount={3}
      />,
    )
    expect(screen.getByText("assignments.table.noReposYet")).toBeTruthy()
    expect(ratioText()).not.toContain("0 / 3")
  })

  it("applies to a bare empty_repo assignment too", () => {
    orgRepos.mockReturnValue({
      data: [repo("cs101-hw1-alice")],
      isPending: false,
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ empty_repo: true })]}
        studentCount={1}
      />,
    )
    expect(screen.getByText("assignments.table.reposAccepted")).toBeTruthy()
  })

  it("shimmers instead of flashing a zero while the repo list resolves", () => {
    orgRepos.mockReturnValue({ data: undefined, isPending: true })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ no_autograder: true })]}
        studentCount={2}
      />,
    )
    expect(screen.queryByText("assignments.table.noReposYet")).toBeNull()
    expect(document.querySelector(".skeleton")).toBeTruthy()
  })

  it("leaves a normal autograded assignment on the ratio", () => {
    scores.mockReturnValue({ data: { submissions: { hw1: [{}] } } })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={4}
      />,
    )
    expect(ratioText()).toContain("1 / 4")
    expect(screen.queryByText("assignments.table.reposAccepted")).toBeNull()
  })

  it("does not read the org repo list when no row needs it", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={4}
      />,
    )
    // Second arg is the `enabled` gate: a whole-org pagination must not be paid
    // for a table where every assignment autogrades.
    expect(orgRepos).toHaveBeenCalledWith("acme", false)
  })

  it("does not count a sibling assignment whose slug extends this one", () => {
    orgRepos.mockReturnValue({
      data: [repo("cs101-hw1-alice"), repo("cs101-hw1-bonus-bob")],
      isPending: false,
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[
          assignment({ no_autograder: true }),
          assignment({ slug: "hw1-bonus", name: "Bonus" }),
        ]}
        studentCount={2}
      />,
    )
    // hw1 sees only alice; hw1-bonus-bob belongs to the sibling.
    expect(screen.getByText("assignments.table.reposAccepted")).toBeTruthy()
  })
})
