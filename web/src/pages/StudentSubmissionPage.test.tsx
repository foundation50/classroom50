// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DetectedSubmission } from "@/domain/assignments/submissionDetection"
import type { GitHubCommit } from "@/github-core/types"
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

let releasesData: unknown[] = []
vi.mock("@/hooks/useGetSubmissionReleases", () => ({
  default: () => ({
    data: releasesData,
    isLoading: false,
    isError: false,
    error: null,
  }),
}))

let taggedData: DetectedSubmission[] = []
const taggedSpy = vi.fn()
vi.mock("@/hooks/useGetMyTaggedSubmissions", () => ({
  default: (...args: unknown[]) => {
    taggedSpy(...args)
    return { data: taggedData }
  },
}))

let pushData: GitHubCommit[] = []
const pushSpy = vi.fn()
vi.mock("@/hooks/useGetMyPushSubmissions", () => ({
  default: (...args: unknown[]) => {
    pushSpy(...args)
    return { data: pushData }
  },
}))

let assignmentData: Assignment | undefined
vi.mock("@/hooks/useGetPublicAssignment", () => ({
  default: () => ({ assignment: assignmentData }),
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
  taggedSpy.mockReset()
  pushSpy.mockReset()
})

afterEach(cleanup)

describe("StudentSubmissionPage submission type", () => {
  it("shows the every-push type badge and the push-count chip by default", () => {
    assignmentData = assignment({ submission_mode: "every-push" })
    pushData = [commit("aaa", "2026-06-20T10:00:00Z")]
    render(<StudentSubmissionPage />)
    expect(screen.getByText("submissions.type.badgeEveryPush")).toBeTruthy()
    // The count chip is the every-push count key; the tagged hook stays disabled
    // (undefined args) so tag reads don't fire in push mode.
    expect(
      screen.getByRole("button", { name: "submissions.type.countEveryPush" }),
    ).toBeTruthy()
    expect(taggedSpy).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    )
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
    // The push hook stays disabled in tag mode.
    expect(pushSpy).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it("shows the empty state with a tags link in tag mode when there are no tags", async () => {
    const user = userEvent.setup()
    assignmentData = assignment({ submission_mode: "tag" })
    taggedData = []
    render(<StudentSubmissionPage />)
    await user.click(
      screen.getByRole("button", { name: "submissions.type.countTag" }),
    )
    expect(screen.getByText("submissions.details.emptyTag")).toBeTruthy()
    const emptyLink = screen.getByRole("link", {
      name: /submissions\.details\.emptyLinkTags/,
    })
    expect(emptyLink.getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice/tags",
    )
  })
})
