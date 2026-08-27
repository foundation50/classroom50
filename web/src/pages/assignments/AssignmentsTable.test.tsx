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
const MANAGE_ARIA = "assignments.manageModal.openAria"

// Opens the assignment hub for the first (only) rendered row.
const openHub = () => fireEvent.click(screen.getByLabelText(MANAGE_ARIA))

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

describe("AssignmentsTable — Template access action (in the hub)", () => {
  it("shows the action in the hub for an in-org templated assignment", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ template: inOrgTemplate })]}
        studentCount={0}
      />,
    )
    // Not a quick action anymore — it lives behind the Manage trigger.
    expect(screen.queryByLabelText(ACCESS_ARIA)).toBeNull()
    openHub()
    expect(screen.queryByLabelText(ACCESS_ARIA)).toBeTruthy()
  })

  it("shows it for an out-of-org template too (review + link)", () => {
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
    openHub()
    expect(screen.queryByLabelText(ACCESS_ARIA)).toBeTruthy()
  })

  it("does not show it for a template-less assignment", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={0}
      />,
    )
    openHub()
    expect(screen.queryByLabelText(ACCESS_ARIA)).toBeNull()
  })

  it("still shows it when archived (viewing stays available)", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ template: inOrgTemplate })]}
        studentCount={0}
        archived
      />,
    )
    openHub()
    expect(screen.queryByLabelText(ACCESS_ARIA)).toBeTruthy()
  })

  it("opens the template-access modal from the hub", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ template: inOrgTemplate })]}
        studentCount={0}
      />,
    )
    openHub()
    expect(screen.queryByTestId("template-access-modal")).toBeNull()
    fireEvent.click(screen.getByLabelText(ACCESS_ARIA))
    expect(screen.getByTestId("template-access-modal").textContent).toBe("hw1")
  })
})

describe("AssignmentsTable — assignment hub", () => {
  it("keeps only the quick actions on the row; the rest live in the hub", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ template: inOrgTemplate })]}
        studentCount={0}
        canAuthor
      />,
    )
    // Quick actions: accept link, clone CLI, edit (a router link whose title
    // the Link mock drops — covered by the hub assertions below), lock, plus
    // the trigger.
    expect(screen.getByLabelText("assignments.table.copyLinkAria")).toBeTruthy()
    expect(screen.getByLabelText("assignments.table.cloneAria")).toBeTruthy()
    expect(screen.getByLabelText("assignments.table.lockAria")).toBeTruthy()
    // Consolidated actions are not on the row.
    expect(screen.queryByLabelText(ACCESS_ARIA)).toBeNull()
    expect(screen.queryByLabelText("assignments.table.reuseAria")).toBeNull()
    expect(screen.queryByLabelText("assignments.table.deleteAria")).toBeNull()
  })

  it("consolidates every action (quick ones included) for an author", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment({ template: inOrgTemplate })]}
        studentCount={0}
        canAuthor
      />,
    )
    openHub()
    expect(screen.getByText("assignments.table.editAssignment")).toBeTruthy()
    // Quick actions repeat inside the hub (row + hub = 2 matches each).
    expect(
      screen.getAllByLabelText("assignments.table.copyLinkAria").length,
    ).toBe(2)
    expect(screen.getAllByLabelText("assignments.table.cloneAria").length).toBe(
      2,
    )
    expect(screen.getAllByLabelText("assignments.table.lockAria").length).toBe(
      2,
    )
    expect(screen.getByLabelText(ACCESS_ARIA)).toBeTruthy()
    expect(screen.getByLabelText("assignments.table.reuseAria")).toBeTruthy()
    expect(screen.getByLabelText("assignments.table.deleteAria")).toBeTruthy()
  })

  it("hides the mutating rows for a read-only viewer", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs101"
        assignments={[assignment()]}
        studentCount={0}
      />,
    )
    openHub()
    expect(screen.getByText("assignments.table.viewAssignment")).toBeTruthy()
    expect(screen.queryByLabelText("assignments.table.reuseAria")).toBeNull()
    expect(screen.queryByLabelText("assignments.table.lockAria")).toBeNull()
    expect(screen.queryByLabelText("assignments.table.deleteAria")).toBeNull()
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

describe("AssignmentsTable selection head", () => {
  const rows = [assignment(), assignment({ slug: "hw2", name: "HW 2" })]
  const selectionProps = (selected: string[]) => ({
    selectedSlugs: new Set(selected),
    onToggleRow: () => {},
    onToggleSelectAll: () => {},
    bulkActions: <span data-testid="bulk-actions">actions</span>,
  })

  it("shows the column titles while nothing is selected", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs50"
        assignments={rows}
        canAuthor
        {...selectionProps([])}
      />,
    )

    expect(screen.getByText("assignments.table.colType")).toBeTruthy()
    expect(screen.queryByTestId("bulk-actions")).toBeNull()
  })

  // One row owns the selection, its count and its actions — a separate bar
  // above the table would carry a second select-all box for the same state.
  it("hands the head row over to the bulk actions once a row is selected", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs50"
        assignments={rows}
        canAuthor
        {...selectionProps(["hw1"])}
      />,
    )

    expect(screen.getByTestId("bulk-actions")).toBeTruthy()
    expect(screen.queryByText("assignments.table.colType")).toBeNull()
    // The select-all box survives the takeover — it is the one control the
    // head row must keep.
    expect(screen.getByLabelText("assignments.bulk.selectAll")).toBeTruthy()
  })

  // A selection made before the search narrowed the view keeps the head row
  // (and its count) alive over zero rows.
  it("disables select-all when the view holds no rows to select", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs50"
        assignments={[]}
        allAssignments={rows}
        canAuthor
        {...selectionProps(["hw1"])}
      />,
    )

    expect(screen.getByLabelText("assignments.bulk.selectAll")).toHaveProperty(
      "disabled",
      true,
    )
  })

  it("renders the caller's empty state instead of the default", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs50"
        assignments={[]}
        allAssignments={rows}
        empty={<p>no matches</p>}
        canAuthor
        {...selectionProps(["hw1"])}
      />,
    )

    expect(screen.getByText("no matches")).toBeTruthy()
    expect(screen.queryByText("assignments.table.empty")).toBeNull()
  })

  // Without it, ticking a row would swap the column titles for a blank cell.
  it("renders no checkbox column when the bulk actions are missing", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs50"
        assignments={rows}
        canAuthor
        selectedSlugs={new Set<string>()}
        onToggleRow={() => {}}
        onToggleSelectAll={() => {}}
      />,
    )

    expect(screen.queryByLabelText("assignments.bulk.selectAll")).toBeNull()
    expect(screen.getByText("assignments.table.colType")).toBeTruthy()
  })

  it("renders no checkbox column at all without selection wiring", () => {
    wrap(
      <AssignmentsTable
        org="acme"
        classroom="cs50"
        assignments={rows}
        canAuthor
      />,
    )

    expect(screen.queryByLabelText("assignments.bulk.selectAll")).toBeNull()
  })
})
