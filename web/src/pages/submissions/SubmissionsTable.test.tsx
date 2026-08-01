// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "repo" in opts ? `${key}:${String(opts.repo)}` : key,
    }),
  }
})

// The row's hooks/modals fetch from GitHub or need providers; stub them so the
// test targets only the table's row rendering.
const collaborators = vi.fn()
vi.mock("@/hooks/useGetRepoCollaborators", () => ({
  default: (...a: unknown[]) => collaborators(...a),
}))
vi.mock("@/hooks/useGetFeedbackPr", () => ({
  default: () => ({ refetch: vi.fn() }),
}))
vi.mock("@/hooks/mutations/useRepairFeedbackPr", () => ({
  default: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify: vi.fn() }),
}))
vi.mock("@/hooks/useTriggerRegrade", () => ({
  default: () => ({ regrade: vi.fn(), phase: "idle", anyRegrading: false }),
}))
const downloadSubmission = vi.fn()
vi.mock("@/hooks/mutations/useDownloadSubmission", () => ({
  default: () => ({ mutate: downloadSubmission, isPending: false }),
}))
vi.mock("@/components/modals/GroupCollaboratorsModal", () => ({
  GroupCollaboratorsModal: () => null,
}))
vi.mock("@/components/modals/StudentProfileModal", () => ({
  StudentProfileModal: () => null,
}))

import SubmissionsTable from "./SubmissionsTable"
import type { Student } from "@/types/classroom"
import type { SubmissionRow } from "@/hooks/useGetScores"

const student = (over: Partial<Student> = {}): Student => ({
  username: "alice",
  first_name: "Alice",
  last_name: "A",
  email: "alice@example.com",
  section: "",
  github_id: "1",
  role: "student",
  ...over,
})

const scoreRow = (over: Partial<SubmissionRow> = {}): SubmissionRow => ({
  usernames: ["alice"],
  owner: "alice",
  datetime: "2026-06-20T10:00:00Z",
  commit: "",
  release: "",
  review: "",
  score: 8,
  "max-score": 10,
  submissionCount: 1,
  late: false,
  submissions: [],
  ...over,
})

beforeEach(() => {
  collaborators.mockReset()
  collaborators.mockReturnValue({ data: undefined })
  downloadSubmission.mockReset()
})

afterEach(cleanup)

const baseProps = {
  scores: [],
  students: [student()],
  org: "acme",
  classroom: "cs101",
  assignment: "hw1",
}

describe("SubmissionsTable non-submitter repo links", () => {
  it("links to the repo for an accepted-not-submitted individual", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    const link = screen.getByRole("link", {
      name: "submissions.table.openRepoLabel:cs101-hw1-alice",
    })
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice",
    )
  })

  it("shows no repo link for a never-accepted individual", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set()}
      />,
    )
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("renders unsubmitted group repos with a repo link even with no roster match", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        students={[]}
        isGroup
        unsubmittedGroupRepos={[
          {
            owner: "team-rocket",
            repoName: "cs101-hw1-team-rocket",
          },
        ]}
      />,
    )
    const link = screen.getByRole("link", {
      name: "submissions.table.openRepoLabel:cs101-hw1-team-rocket",
    })
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-team-rocket",
    )
    // The empty-state row must not render alongside group-repo rows.
    expect(screen.queryByText("submissions.table.emptyNoDataTitle")).toBeNull()
    // Members are loaded lazily (via the Members modal), not eagerly per row,
    // so the row's collaborators query stays cache-only (enabled: false).
    expect(collaborators).toHaveBeenCalledWith(
      "acme",
      "cs101-hw1-team-rocket",
      {
        enabled: false,
      },
    )
  })
})

describe("SubmissionsTable initial loading", () => {
  it("shows the loading state and not the empty state while core data loads", () => {
    render(<SubmissionsTable {...baseProps} initialLoading />)
    expect(screen.getByText("submissions.table.loading")).toBeTruthy()
    expect(screen.queryByText("submissions.table.emptyNoDataTitle")).toBeNull()
  })

  it("shows the empty state (not loading) once loaded with no data", () => {
    render(<SubmissionsTable {...baseProps} initialLoading={false} />)
    expect(screen.getByText("submissions.table.emptyNoDataTitle")).toBeTruthy()
    expect(screen.queryByText("submissions.table.loading")).toBeNull()
  })
})

describe("SubmissionsTable empty_repo score cell", () => {
  it("renders a no-grading em-dash instead of a score for an empty_repo assignment", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
        emptyRepo
      />,
    )
    // The score cell shows the placeholder titled noGradingTitle instead of a
    // numeric score badge (bare repos never autograde).
    expect(screen.getByTitle("submissions.table.noGradingTitle")).toBeTruthy()
  })

  it("shows a score badge (not the no-grading placeholder) when not empty_repo", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    expect(screen.queryByTitle("submissions.table.noGradingTitle")).toBeNull()
  })
})

describe("SubmissionsTable per-row download", () => {
  it("renders a download button for a submitter row and fires the hook on click", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    const btn = screen.getByTitle("submissions.rowDownload.title")
    btn.click()
    expect(downloadSubmission).toHaveBeenCalledWith(
      {
        org: "acme",
        classroom: "cs101",
        assignment: "hw1",
        owner: "alice",
      },
      expect.objectContaining({ onError: expect.any(Function) }),
    )
  })

  it("renders the download button even for an empty_repo assignment", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
        emptyRepo
      />,
    )
    expect(screen.getByTitle("submissions.rowDownload.title")).toBeTruthy()
  })

  it("shows the download button for an accepted-not-submitted non-submitter", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    // The full per-repo action cluster now renders for non-submitters; an
    // accepted student has a repo, so Download is enabled.
    const btn = screen.getByTitle("submissions.rowDownload.title")
    expect(btn.hasAttribute("disabled")).toBe(false)
  })

  it("disables the download button for a never-accepted non-submitter", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set()}
      />,
    )
    // No repo exists, so Download shows but is disabled (via titleNoRepo).
    const btn = screen.getByTitle("submissions.rowDownload.titleNoRepo")
    expect(btn.hasAttribute("disabled")).toBe(true)
  })
})

describe("SubmissionsTable non-submitter action cluster", () => {
  it("shows the repo-scoped actions (Review, Manage access, Regrade) for a non-submitter", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    expect(screen.getByTitle("submissions.table.review")).toBeTruthy()
    expect(screen.getByTitle("submissions.table.manageAccess")).toBeTruthy()
    expect(screen.getByTitle("submissions.rowRegrade.title")).toBeTruthy()
  })

  it("disables the repo-scoped actions for a never-accepted non-submitter", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set()}
      />,
    )
    expect(
      screen
        .getByTitle("submissions.table.reviewNoRepo")
        .hasAttribute("disabled"),
    ).toBe(true)
    expect(
      screen
        .getByTitle("submissions.table.manageAccessNoRepo")
        .hasAttribute("disabled"),
    ).toBe(true)
    expect(
      screen
        .getByTitle("submissions.rowRegrade.titleNoRepo")
        .hasAttribute("disabled"),
    ).toBe(true)
  })

  it("hides grading actions for an empty_repo non-submitter but keeps repo + download", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set(["alice"])}
        emptyRepo
      />,
    )
    // empty_repo never autogrades: Review/Manage access/Regrade are hidden,
    // but Open repo and Download stay.
    expect(screen.queryByTitle("submissions.table.review")).toBeNull()
    expect(screen.queryByTitle("submissions.rowRegrade.title")).toBeNull()
    expect(
      screen.getByRole("link", {
        name: "submissions.table.openRepoLabel:cs101-hw1-alice",
      }),
    ).toBeTruthy()
    expect(screen.getByTitle("submissions.rowDownload.title")).toBeTruthy()
    // Manage access is one of the grading-tier actions hidden for empty_repo.
    expect(screen.queryByTitle("submissions.table.manageAccess")).toBeNull()
  })

  it("shows an em-dash (no actions) while acceptance data is still loading", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={undefined}
      />,
    )
    // acceptedUsernames === undefined means acceptance is unknown (org repo list
    // not loaded): the row must not assert "hasn't accepted" with a disabled
    // cluster, so no action controls render at all.
    expect(screen.queryByTitle("submissions.table.review")).toBeNull()
    expect(screen.queryByTitle("submissions.table.reviewNoRepo")).toBeNull()
    expect(screen.queryByTitle("submissions.rowDownload.title")).toBeNull()
    expect(
      screen.queryByTitle("submissions.rowDownload.titleNoRepo"),
    ).toBeNull()
  })

  it("renders the shared action cluster for a group submitter row", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        isGroup
        scores={[scoreRow({ owner: "team-rocket", usernames: ["alice"] })]}
      />,
    )
    // Group rows go through the same RepoRowActions as individual rows, so the
    // Review/Regrade/Download tail must be present (parity with the individual
    // submitter row, which shares the component).
    expect(screen.getByTitle("submissions.table.review")).toBeTruthy()
    expect(screen.getByTitle("submissions.rowRegrade.title")).toBeTruthy()
    expect(screen.getByTitle("submissions.rowDownload.title")).toBeTruthy()
    // Members button (group header) is present; the per-student Manage-access
    // button is not (group access is managed via the Members modal).
    expect(screen.getByTitle("submissions.table.members")).toBeTruthy()
    expect(screen.queryByTitle("submissions.table.manageAccess")).toBeNull()
  })
})
