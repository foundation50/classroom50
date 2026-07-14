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
vi.mock("@/hooks/useTriggerRegrade", () => ({
  default: () => ({ regrade: vi.fn(), phase: "idle", anyRegrading: false }),
}))
vi.mock("@/components/modals/GroupCollaboratorsModal", () => ({
  GroupCollaboratorsModal: () => null,
}))
vi.mock("@/components/modals/StudentProfileModal", () => ({
  StudentProfileModal: () => null,
}))

import SubmissionsTable from "./SubmissionsTable"
import type { Student } from "@/types/classroom"

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

beforeEach(() => {
  collaborators.mockReset()
  collaborators.mockReturnValue({ data: undefined })
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
