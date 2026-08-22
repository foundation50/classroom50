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
  scores.mockReturnValue({ data: { submissions: {}, detected: {} } })
  orgRepos.mockReset()
  orgRepos.mockReturnValue({ data: undefined })
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

  it("falls back to a bare submitted count while the org repo list loads", () => {
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

  it("uses existing group repos as the group denominator once repos load", () => {
    scores.mockReturnValue({ data: { submissions: { hw1: [{}, {}] } } })
    orgRepos.mockReturnValue({
      data: [
        { name: "cs101-hw1-team1" },
        { name: "cs101-hw1-team2" },
        { name: "cs101-hw1-team3" },
        { name: "cs101-hw2-team1" }, // another assignment's repo — excluded
      ],
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ mode: "group" })]}
        studentCount={11}
      />,
    )
    expect(ratioText()).toContain("2 / 3")
    expect(document.querySelector("progress")).toBeTruthy()
    expect(ratioText()).not.toContain("/ 11")
  })

  it("clamps the group ratio so a stale submission can't exceed the repo count", () => {
    scores.mockReturnValue({ data: { submissions: { hw1: [{}, {}, {}] } } })
    orgRepos.mockReturnValue({
      data: [{ name: "cs101-hw1-team1" }, { name: "cs101-hw1-team2" }],
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ mode: "group" })]}
        studentCount={11}
      />,
    )
    expect(ratioText()).toContain("2 / 2")
    expect(ratioText()).not.toContain("3 / 2")
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

// An assignment that skips grading records no graded `entries`, so its count
// comes from the collected `detected` list instead (#659). The cell renders the
// same N / M + progress bar as an autograded row, so the two read consistently.
describe("AssignmentsTable — assignments that skip grading", () => {
  const detected = (owners: string[]) =>
    owners.map((owner) => ({ owner, usernames: [owner], count: 1 }))

  it("shows a real ratio and progress bar from collected detection", () => {
    scores.mockReturnValue({
      data: { submissions: {}, detected: { hw1: detected(["alice", "bob"]) } },
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ no_autograder: true })]}
        studentCount={3}
      />,
    )
    expect(ratioText()).toContain("2 / 3")
    expect(document.querySelector("progress")).toBeTruthy()
  })

  it("shows 0 / N once collected with no submitters", () => {
    // An empty `detected` list means the bucket WAS walked and nobody has
    // submitted — an honest zero, unlike the permanent 0/N this replaced.
    scores.mockReturnValue({
      data: { submissions: {}, detected: { hw1: [] } },
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ no_autograder: true })]}
        studentCount={3}
      />,
    )
    expect(ratioText()).toContain("0 / 3")
  })

  it("says not collected yet when no collect has walked the bucket", () => {
    // The key is absent, which is NOT "nobody submitted" — showing 0/N here is
    // exactly the bug (#659), so the cell must not imply a count.
    scores.mockReturnValue({ data: { submissions: {}, detected: {} } })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ no_autograder: true })]}
        studentCount={3}
      />,
    )
    expect(screen.getByText("assignments.table.notCollectedYet")).toBeTruthy()
    expect(ratioText()).not.toContain("0 / 3")
    expect(document.querySelector("progress")).toBeNull()
  })

  it("applies to a bare empty_repo assignment too", () => {
    // empty_repo is never detected (no submission definition), so it keeps the
    // entries-based count rather than waiting for a `detected` list no writer
    // produces — otherwise it would read "not collected yet" forever.
    scores.mockReturnValue({
      data: { submissions: { hw1: [{}] }, detected: {} },
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ empty_repo: true })]}
        studentCount={2}
      />,
    )
    expect(ratioText()).toContain("1 / 2")
    expect(screen.queryByText("assignments.table.notCollectedYet")).toBeNull()
  })

  it("keeps hand-entered grades visible when detection finds fewer", () => {
    // A teacher can hand-grade a no_autograder assignment, which writes real
    // entries. An empty or partial detection must not hide them.
    scores.mockReturnValue({
      data: { submissions: { hw1: [{}, {}, {}] }, detected: { hw1: [] } },
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ no_autograder: true })]}
        studentCount={4}
      />,
    )
    expect(ratioText()).toContain("3 / 4")
  })

  it("never reads detection for a normally autograded assignment", () => {
    // A graded row's count must keep coming from `submissions`; a stray
    // `detected` bucket must not override it.
    scores.mockReturnValue({
      data: {
        submissions: { hw1: [{}] },
        detected: { hw1: detected(["a", "b", "c"]) },
      },
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={4}
      />,
    )
    expect(ratioText()).toContain("1 / 4")
  })

  it("counts detected group submissions per repo", () => {
    scores.mockReturnValue({
      data: { submissions: {}, detected: { hw1: detected(["team-1"]) } },
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ no_autograder: true, mode: "group" })]}
        studentCount={5}
      />,
    )
    expect(screen.getByText("assignments.table.groupsSubmitted")).toBeTruthy()
  })
})
