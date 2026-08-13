// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DetectedSubmission } from "@/domain/assignments/submissionDetection"
import type { GitHubCommit, GitHubRelease } from "@/github-core/types"
import type { Assignment } from "@/types/classroom"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
    Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  }
})

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    useParams: () => ({ org: "acme", classroom: "cs101", assignment: "hw1" }),
    Link: ({ children }: { children?: React.ReactNode }) => (
      <span>{children}</span>
    ),
  }
})

vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "alice" } }),
}))

vi.mock("@/hooks/useDocumentTitle", () => ({
  useDocumentTitle: () => {},
}))

// The student repo exists (accepted).
vi.mock("@/hooks/useGetAssignmentRepo", () => ({
  default: () => ({
    assignment: { html_url: "https://github.com/acme/cs101-hw1-alice" },
    isLoading: false,
    isError: false,
    error: null,
  }),
}))

// The page consumes one consolidated submissions hook; drive its return
// directly (per-hook gating is covered by useMySubmissions' own test).
let releasesData: GitHubRelease[] = []
let taggedData: DetectedSubmission[] = []
let pushData: GitHubCommit[] = []
vi.mock("@/hooks/useMySubmissions", () => ({
  default: () => ({
    releases: releasesData,
    tags: taggedData,
    pushes: pushData,
    releasesLoading: false,
    releasesError: false,
    releasesErrorObj: null,
    submissionListError: false,
  }),
}))

let assignmentData: Assignment | undefined
let assignmentError = false
vi.mock("@/hooks/useSubmissionAssignment", () => ({
  useSubmissionAssignment: () => ({
    assignment: assignmentData,
    assignments: assignmentData ? [assignmentData] : [],
    isLoading: false,
    isError: assignmentError,
  }),
}))

vi.mock("@/hooks/useGetClassroom", () => ({
  default: () => ({ data: undefined }),
}))

vi.mock("@/hooks/useDotClassroom50", () => ({
  default: () => ({ secret: undefined }),
}))

// The submit-guidance block uses clipboard; stub it so the page test stays
// focused on the submission-details surface.
vi.mock("@/components/SubmitGuidance", () => ({
  default: () => <div data-testid="submit-guidance" />,
}))

import StudentSubmissionPage from "./StudentSubmissionPage"

const assignment = (over: Partial<Assignment> = {}): Assignment =>
  ({
    slug: "hw1",
    name: "Homework 1",
    mode: "individual",
    ...over,
  }) as Assignment

const commit = (sha: string, date: string): GitHubCommit =>
  ({
    sha,
    html_url: `https://github.com/acme/cs101-hw1-alice/commit/${sha}`,
    commit: { message: sha, author: { date } },
    author: null,
  }) as GitHubCommit

beforeEach(() => {
  releasesData = []
  taggedData = []
  pushData = []
  assignmentData = assignment()
  assignmentError = false
})

afterEach(cleanup)

describe("StudentSubmissionPage grading badge", () => {
  it("shows the autograded badge for built-in autograding", () => {
    render(<StudentSubmissionPage />)
    expect(screen.getByText("submissions.grading.badgeBuiltIn")).toBeTruthy()
  })

  it("shows the teacher-CI badge for no_autograder assignments", () => {
    assignmentData = assignment({ no_autograder: true })
    render(<StudentSubmissionPage />)
    expect(
      screen.getByText("submissions.grading.badgeNoAutograder"),
    ).toBeTruthy()
  })

  it("shows the no-autograding badge for empty_repo assignments", () => {
    assignmentData = assignment({ empty_repo: true })
    render(<StudentSubmissionPage />)
    expect(screen.getByText("submissions.grading.badgeEmptyRepo")).toBeTruthy()
  })
})

describe("StudentSubmissionPage submission type", () => {
  it("shows the every-push type badge and the push-count chip by default", () => {
    assignmentData = assignment({ submission_mode: "every-push" })
    pushData = [commit("aaa", "2026-06-20T10:00:00Z")]
    render(<StudentSubmissionPage />)
    expect(screen.getByText("submissions.type.badgeEveryPush")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "submissions.type.countEveryPush" }),
    ).toBeTruthy()
  })

  it("opens the details modal with each commit in every-push mode", async () => {
    const user = userEvent.setup()
    assignmentData = assignment({ submission_mode: "every-push" })
    pushData = [
      commit("bbb", "2026-06-21T10:00:00Z"),
      commit("aaa", "2026-06-20T10:00:00Z"),
    ]
    render(<StudentSubmissionPage />)
    await user.click(
      screen.getByRole("button", { name: "submissions.type.countEveryPush" }),
    )
    const commitLinks = screen.getAllByRole("link", {
      name: "submissions.details.viewCommit",
    })
    expect(commitLinks).toHaveLength(2)
    expect(commitLinks[0].getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice/commit/bbb",
    )
  })

  it("lists tagged submissions in the details modal in tag mode", async () => {
    const user = userEvent.setup()
    assignmentData = assignment({
      submission_mode: "tag",
      submission_tags: ["phase1"],
    })
    taggedData = [{ kind: "tag", label: "phase1", count: 1, sha: "aaa1111" }]
    render(<StudentSubmissionPage />)
    expect(screen.getByText("submissions.type.badgeTag")).toBeTruthy()
    await user.click(
      screen.getByRole("button", { name: "submissions.type.countTag" }),
    )
    const view = screen.getByRole("link", {
      name: "submissions.details.viewTag",
    })
    expect(view.getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/phase1",
    )
  })

  it("shows awaiting-grading (not 'not submitted') for an ungraded pushed tag", () => {
    // Tag mode: a pushed milestone tag counts in the chip, but no submit/*
    // release exists yet (grading pending or teacher-supplied CI). "Not
    // submitted yet" beside a positive count contradicts itself — the cell
    // must say the submission exists and is awaiting grading.
    assignmentData = assignment({
      submission_mode: "tag",
      submission_tags: ["phase1"],
    })
    taggedData = [{ kind: "tag", label: "phase1", count: 1, sha: "aaa1111" }]
    releasesData = []
    render(<StudentSubmissionPage />)
    expect(
      screen.getByText("submissions.student.submittedAwaitingGrading"),
    ).toBeTruthy()
    expect(
      screen.queryByText("submissions.student.notSubmittedYet"),
    ).toBeNull()
  })

  it("still shows 'not submitted yet' in tag mode with no tags and no releases", () => {
    assignmentData = assignment({
      submission_mode: "tag",
      submission_tags: ["phase1"],
    })
    render(<StudentSubmissionPage />)
    expect(
      screen.getByText("submissions.student.notSubmittedYet"),
    ).toBeTruthy()
  })

  it("renders as a one-row table with the student column set", () => {
    assignmentData = assignment({ submission_mode: "every-push" })
    pushData = [commit("aaa", "2026-06-20T10:00:00Z")]
    render(<StudentSubmissionPage />)
    // The student view mirrors the teacher table's columns (minus score/manage).
    expect(screen.getByText("submissions.table.colStudent")).toBeTruthy()
    expect(screen.getByText("submissions.table.colSubmissions")).toBeTruthy()
    expect(screen.getByText("submissions.table.colLastSubmitted")).toBeTruthy()
    expect(screen.getByText("submissions.table.colActions")).toBeTruthy()
    // The identity cell links the student's own repo.
    const repoLink = screen.getByRole("link", { name: "cs101-hw1-alice" })
    expect(repoLink.getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice",
    )
  })

  it("folds the graded release into a per-commit View grade link", async () => {
    const user = userEvent.setup()
    assignmentData = assignment({ submission_mode: "every-push" })
    pushData = [commit("abc1234", "2026-06-21T10:00:00Z")]
    releasesData = [
      {
        id: 1,
        tag_name: "submit/2026-06-21T10-00-00Z-abc1234",
        name: null,
        html_url:
          "https://github.com/acme/cs101-hw1-alice/releases/tag/submit%2F...",
        draft: false,
        prerelease: false,
        created_at: "2026-06-21T10:05:00Z",
        published_at: "2026-06-21T10:05:00Z",
      },
    ]
    render(<StudentSubmissionPage />)
    await user.click(
      screen.getByRole("button", { name: "submissions.type.countEveryPush" }),
    )
    const gradeLink = screen.getByRole("link", {
      name: "submissions.details.viewGrade",
    })
    expect(gradeLink.getAttribute("href")).toContain("/releases/tag/")
  })

  it("surfaces an error (not the submission table) when the assignment metadata read fails", () => {
    // A transient Pages metadata failure must surface rather than degrade to a
    // slug title + default push mode. The submission table should not render.
    assignmentError = true
    assignmentData = undefined
    render(<StudentSubmissionPage />)
    expect(screen.getByText("submissions.student.loadError")).toBeTruthy()
    expect(screen.queryByText("submissions.table.colSubmissions")).toBeNull()
  })
})
