// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

import type { DetectedSubmission } from "@/domain/assignments/submissionDetection"
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

// The submit-guidance block uses clipboard; render a stub so the page test
// stays focused on the tagged-submission surface.
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

beforeEach(() => {
  releasesData = []
  taggedData = []
  assignmentData = assignment()
  taggedSpy.mockReset()
})

afterEach(cleanup)

describe("StudentSubmissionPage submission type", () => {
  it("shows the every-push mode badge and no tagged card by default", () => {
    assignmentData = assignment({ submission_mode: "every-push" })
    render(<StudentSubmissionPage />)
    expect(screen.getByText("submissions.student.modeEveryPush")).toBeTruthy()
    expect(screen.queryByText("submissions.student.taggedIntro")).toBeNull()
    // The tagged-submissions hook stays disabled outside tag mode (undefined
    // org keeps the query off).
    expect(taggedSpy).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it("lists tagged submissions with a jump-to-tree link in tag mode", () => {
    assignmentData = assignment({
      submission_mode: "tag",
      submission_tags: ["phase1"],
    })
    taggedData = [{ kind: "tag", label: "phase1", count: 1, sha: "aaa1111" }]
    render(<StudentSubmissionPage />)
    expect(screen.getByText("submissions.student.modeTag")).toBeTruthy()
    const jump = screen.getByRole("link", {
      name: /submissions\.student\.jumpToTag/,
    })
    expect(jump.getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/phase1",
    )
  })

  it("shows the empty hint in tag mode when the student has no tags yet", () => {
    assignmentData = assignment({ submission_mode: "tag" })
    taggedData = []
    render(<StudentSubmissionPage />)
    expect(screen.getByText("submissions.student.taggedEmpty")).toBeTruthy()
  })

  it("jumps a glob tag-group to its representative commit sha", () => {
    assignmentData = assignment({
      submission_mode: "tag",
      submission_tags: ["v*"],
    })
    taggedData = [{ kind: "tag-group", label: "v*", count: 2, sha: "bbb2222" }]
    render(<StudentSubmissionPage />)
    const jump = screen.getByRole("link", {
      name: /submissions\.student\.jumpToTag/,
    })
    expect(jump.getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/bbb2222",
    )
  })
})
