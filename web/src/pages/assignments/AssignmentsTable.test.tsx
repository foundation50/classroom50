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

// The author-tier rows mount the lock action, which reads the toast context;
// the table test doesn't exercise notifications, so stub the hook rather than
// wrapping every render in a provider.
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify: () => {} }),
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

// Table-wide text (the bars' "value / max" ratios, percentages, fallback
// strings).
const ratioText = () =>
  screen.getByText("assignments.table.colSubmitted").closest("table")
    ?.textContent ?? ""

// The metric bars (native <progress>), for presence/count assertions; the
// exact numbers are asserted via the visible ratio text.
const bars = () => document.querySelectorAll("progress").length

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
    expect(ratioText()).toContain("100%")
  })

  it("renders an empty 0% bar without dividing by zero when there are no students", () => {
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
    expect(ratioText()).toContain("0%")
  })

  it("shows the accepted column from existing repos once the repo list loads", () => {
    scores.mockReturnValue({ data: { submissions: { hw1: [{}, {}] } } })
    orgRepos.mockReturnValue({
      data: [
        { name: "cs101-hw1-alice" },
        { name: "cs101-hw1-bob" },
        { name: "cs101-hw1-carol" },
        { name: "cs101-hw1-dave" },
        { name: "cs101-hw2-erin" }, // another assignment's repo — excluded
      ],
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={5}
      />,
    )
    // Accepted 4 of 5 and submitted 2 of 5, each with its own bar.
    expect(ratioText()).toContain("4 / 5")
    expect(ratioText()).toContain("2 / 5")
    expect(bars()).toBe(2)
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
    expect(bars()).toBe(0)
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
    // Accepted is a bare count (no roster denominator for groups; the tooltip
    // carries the "groups" context); the submitted bar measures against the
    // 3 existing group repos.
    expect(
      screen.getByTitle("assignments.table.groupsAcceptedTitle").textContent,
    ).toBe("3")
    expect(ratioText()).toContain("2 / 3")
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
  })

  it("shows empty states for a group assignment with no repos yet", () => {
    // No group has formed, so there is no denominator to measure — a bare
    // "0" or "0 / 0" would imply one. Each cell says what's missing.
    scores.mockReturnValue({ data: { submissions: {} } })
    orgRepos.mockReturnValue({
      data: [{ name: "cs101-other-assignment-team1" }],
    })
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ mode: "group" })]}
        studentCount={11}
      />,
    )
    expect(screen.getByText("assignments.table.noGroupsYet")).toBeTruthy()
    expect(screen.getByText("—")).toBeTruthy()
    expect(bars()).toBe(0)
    expect(ratioText()).not.toContain("0 / 0")
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
// comes from the collected `detected` list instead (#659). The cell renders
// the same count + bar as an autograded row, so the two read consistently.
describe("AssignmentsTable — assignments that skip grading", () => {
  const detected = (owners: string[]) =>
    owners.map((owner) => ({ owner, usernames: [owner], count: 1 }))

  it("shows a real ratio and bar from collected detection", () => {
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
  })

  it("shows an honest zero once collected with no submitters", () => {
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
    expect(bars()).toBe(0)
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

describe("AssignmentsTable copy accept link", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>()
  const COPY_ARIA = "assignments.table.copyLinkAria"
  const acceptLink = (query = "") =>
    `${window.location.origin}/acme/cs101/assignments/hw1/accept${query}`

  // One author-tier row; each test overrides only the prop it exercises.
  const renderRow = (over: Record<string, unknown> = {}) =>
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        canAuthor
        {...over}
      />,
    )

  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  })

  beforeEach(() => {
    writeText.mockReset()
    writeText.mockResolvedValue(undefined)
  })

  it("copies the student accept link for the row", async () => {
    renderRow()
    fireEvent.click(screen.getByLabelText(COPY_ARIA))
    expect(writeText).toHaveBeenCalledWith(acceptLink())
    // The copied state flips only after the clipboard write resolves.
    expect(
      await screen.findByTitle("assignments.table.linkCopied"),
    ).toBeTruthy()
  })

  it("carries a protected classroom's secret so the link doesn't 404", () => {
    renderRow({ secret: "ab12cd34" })
    fireEvent.click(screen.getByLabelText(COPY_ARIA))
    expect(writeText).toHaveBeenCalledWith(acceptLink("?k=ab12cd34"))
  })

  it("waits for the classroom read rather than copying a keyless link", () => {
    // An unresolved secret reads the same as "unprotected", so copying is held
    // until classroom.json settles — whether it is still loading or the read
    // failed, which the page collapses into this one flag.
    renderRow({ secretPending: true })
    fireEvent.click(screen.getByLabelText(COPY_ARIA))
    expect(writeText).not.toHaveBeenCalled()
    // The disabled state says why, rather than looking like a dead button.
    expect(screen.getByTitle("assignments.table.copyLinkPending")).toBeTruthy()
  })

  it("stays available on read-only rows (archived or non-author)", () => {
    // Copying a link mutates nothing, so it survives the same gate that hides
    // reuse/lock/delete.
    renderRow({ canAuthor: false, archived: true })
    expect(screen.getByLabelText(COPY_ARIA)).toBeTruthy()
    expect(screen.queryByLabelText("assignments.table.deleteAria")).toBeNull()
  })
})
