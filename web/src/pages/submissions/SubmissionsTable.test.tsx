// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

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
vi.mock("@/hooks/useGetRepo", () => ({
  default: () => ({ data: undefined }),
}))
vi.mock("@/hooks/useGetAutogradeState", () => ({
  default: () => ({ data: undefined, isLoading: false, isError: false }),
}))
const feedbackRefetch = vi.fn()
vi.mock("@/hooks/useGetFeedbackPr", () => ({
  default: () => ({ refetch: feedbackRefetch }),
}))
vi.mock("@/hooks/mutations/useRepairFeedbackPr", () => ({
  default: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("@/hooks/mutations/useSetScoreOverride", () => ({
  useSetScoreOverride: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    reset: vi.fn(),
  }),
}))
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify: vi.fn(), announce: vi.fn() }),
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
vi.mock("@/components/modals/RepoAccessModal", () => ({
  RepoAccessModal: () => null,
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
  feedbackRefetch.mockReset()
  vi.stubGlobal("open", vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const baseProps = {
  scores: [],
  students: [student()],
  org: "acme",
  classroom: "cs101",
  assignment: "hw1",
}

// Open the single row's submission hub (ManageSubmissionModal) by clicking its
// Manage trigger, where the consolidated actions live.
async function openHub(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "submissions.manageModal.openAria" }),
  )
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

describe("SubmissionsTable per-row feedback PR shortcut", () => {
  it("resolves the Feedback PR on click and opens it (no eager per-row fetch)", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    // The /pulls lookup is deferred until the shortcut is clicked.
    expect(feedbackRefetch).not.toHaveBeenCalled()
    feedbackRefetch.mockResolvedValueOnce({
      data: { html_url: "https://github.com/acme/cs101-hw1-alice/pull/1" },
      error: null,
    })
    await user.click(
      screen.getByRole("button", {
        name: "submissions.table.openFeedbackPrLabel:cs101-hw1-alice",
      }),
    )
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://github.com/acme/cs101-hw1-alice/pull/1",
        "_blank",
        "noopener,noreferrer",
      ),
    )
  })

  it("offers the repair modal when no Feedback PR exists yet", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    feedbackRefetch.mockResolvedValueOnce({ data: null, error: null })
    await user.click(
      screen.getByRole("button", {
        name: "submissions.table.openFeedbackPrLabel:cs101-hw1-alice",
      }),
    )
    expect(
      await screen.findByText("submissions.reviewModal.emptyTitle"),
    ).toBeTruthy()
    expect(screen.getByText("submissions.repairPr.repair")).toBeTruthy()
    expect(window.open).not.toHaveBeenCalled()
  })

  it("renders an inert shortcut for a never-accepted non-submitter", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set()}
      />,
    )
    // Present (row alignment + explanatory tooltip) but not clickable.
    const shortcut = screen.getByLabelText(
      "submissions.table.openFeedbackPrLabel:cs101-hw1-alice",
    )
    expect(shortcut.getAttribute("aria-disabled")).toBe("true")
    expect(shortcut.getAttribute("href")).toBeNull()
    expect(feedbackRefetch).not.toHaveBeenCalled()
  })

  it("omits the shortcut entirely for an empty_repo assignment", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
        skipsGrading
        emptyRepoAssignment
      />,
    )
    expect(
      screen.queryByLabelText(
        "submissions.table.openFeedbackPrLabel:cs101-hw1-alice",
      ),
    ).toBeNull()
  })

  it("offers the shortcut on an unsubmitted group repo row", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        students={[]}
        isGroup
        unsubmittedGroupRepos={[
          { owner: "team-rocket", repoName: "cs101-hw1-team-rocket" },
        ]}
      />,
    )
    expect(
      screen.getByRole("button", {
        name: "submissions.table.openFeedbackPrLabel:cs101-hw1-team-rocket",
      }),
    ).toBeTruthy()
  })
})

describe("SubmissionsTable initial loading", () => {
  it("shows skeleton rows and not the empty state while core data loads", () => {
    render(<SubmissionsTable {...baseProps} initialLoading />)
    expect(document.querySelector('table[aria-busy="true"]')).toBeTruthy()
    expect(document.querySelector("tr[aria-hidden='true']")).toBeTruthy()
    expect(screen.queryByText("submissions.table.emptyNoDataTitle")).toBeNull()
  })

  it("shows the empty state (not loading) once loaded with no data", () => {
    render(<SubmissionsTable {...baseProps} initialLoading={false} />)
    expect(screen.getByText("submissions.table.emptyNoDataTitle")).toBeTruthy()
    expect(document.querySelector("tr[aria-hidden='true']")).toBeNull()
  })

  it("shows the no-groups empty state for a groupless group assignment", () => {
    // Group mode renders group rows only; the reconciled "no group"
    // non-submitters never appear as rows, so they must not suppress the
    // empty state — a groupless class previously got a silent blank table.
    render(
      <SubmissionsTable
        {...baseProps}
        isGroup
        nonSubmitters={[student(), student({ username: "bob" })]}
        initialLoading={false}
      />,
    )
    expect(
      screen.getByText("submissions.table.emptyNoGroupsTitle"),
    ).toBeTruthy()
    expect(screen.getByText("submissions.table.emptyNoGroupsBody")).toBeTruthy()
  })
})

describe("SubmissionsTable settling", () => {
  it("shimmers the submitter row's volatile cells while settling", () => {
    const { container } = render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
        settling
      />,
    )
    // The count + last-submitted cells shimmer (settling threads down into them)
    // and the swap is marked busy for assistive tech.
    expect(container.querySelectorAll(".skeleton-shimmer").length).toBe(2)
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  it("shows the submitter row's values with no shimmer when not settling", () => {
    const { container } = render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    expect(container.querySelector(".skeleton-shimmer")).toBeNull()
  })
})

describe("SubmissionsTable empty_repo score cell", () => {
  it("renders a no-grading em-dash instead of a score for an empty_repo assignment", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
        skipsGrading
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

describe("SubmissionsTable score override on a no-autograder manual assignment", () => {
  // A templated manual-graded assignment is written as no_autograder (the
  // skipsGrading prop here), so manual grading must win over the no-grading
  // em-dash — otherwise a grade entered via the non-submitter row becomes
  // invisible once the student turns into a submitter row.
  const overrideGrade = {
    org: "acme",
    classroom: "cs101",
    assignment: "hw1",
    assignmentType: "individual" as const,
    mode: "manual" as const,
    maxPoints: 10,
  }

  it("offers the score-override trigger on a submitter row despite skipsGrading", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
        skipsGrading
        overrideGrade={overrideGrade}
      />,
    )
    expect(
      screen.getByRole("button", {
        name: "submissions.scoreOverride.editLabel",
      }),
    ).toBeTruthy()
    expect(screen.queryByTitle("submissions.table.noGradingTitle")).toBeNull()
  })

  it("still shows the no-grading em-dash without overrideGrade", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
        skipsGrading
      />,
    )
    expect(screen.getByTitle("submissions.table.noGradingTitle")).toBeTruthy()
  })

  it("matches the non-submitter row's Add-grade affordance under skipsGrading", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set(["alice"])}
        skipsGrading
        overrideGrade={overrideGrade}
      />,
    )
    expect(
      screen.getByRole("button", {
        name: "submissions.scoreOverride.addLabel",
      }),
    ).toBeTruthy()
  })
})

describe("SubmissionsTable autograded score override", () => {
  const overrideGrade = {
    org: "acme",
    classroom: "cs101",
    assignment: "hw1",
    assignmentType: "individual" as const,
    mode: "auto" as const,
  }

  it("offers the override trigger on a graded autograded row", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow({ score: 8, "max-score": 10 })]}
        acceptedUsernames={new Set(["alice"])}
        overrideGrade={overrideGrade}
      />,
    )
    expect(
      screen.getByRole("button", {
        name: "submissions.scoreOverride.editLabel",
      }),
    ).toBeTruthy()
  })

  it("does not offer the trigger on an empty_repo autograded row", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
        skipsGrading
        overrideGrade={overrideGrade}
      />,
    )
    expect(
      screen.queryByRole("button", {
        name: "submissions.scoreOverride.editLabel",
      }),
    ).toBeNull()
    expect(screen.getByTitle("submissions.table.noGradingTitle")).toBeTruthy()
  })

  it("offers the trigger on a pending autograded row (teacher enters the max)", () => {
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow({ pending: true, score: 0, "max-score": 0 })]}
        acceptedUsernames={new Set(["alice"])}
        overrideGrade={overrideGrade}
      />,
    )
    // The row still reads as pending, but the override trigger is available so
    // a teacher can grade a submission before it's collected.
    expect(screen.getByText("submissions.table.pendingGrade")).toBeTruthy()
    expect(
      screen.getByRole("button", {
        name: "submissions.scoreOverride.addLabel",
      }),
    ).toBeTruthy()
  })
})

describe("SubmissionsTable per-row download", () => {
  it("fires the download hook from the hub for a submitter row", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    await openHub(user)
    screen.getByRole("button", { name: "submissions.rowDownload.aria" }).click()
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

  it("offers download in the hub even for an empty_repo assignment", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
        skipsGrading
        emptyRepoAssignment
      />,
    )
    await openHub(user)
    expect(
      screen.getByRole("button", { name: "submissions.rowDownload.aria" }),
    ).toBeTruthy()
  })

  it("enables download in the hub for an accepted-not-submitted non-submitter", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    await openHub(user)
    const btn = screen.getByRole("button", {
      name: "submissions.rowDownload.aria",
    })
    expect(btn.hasAttribute("disabled")).toBe(false)
  })

  it("disables download in the hub for a never-accepted non-submitter", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set()}
      />,
    )
    await openHub(user)
    const btn = screen.getByRole("button", {
      name: "submissions.rowDownload.aria",
    })
    expect(btn.hasAttribute("disabled")).toBe(true)
  })
})

describe("SubmissionsTable hub action list", () => {
  it("shows the repo-scoped actions (Review, Manage access, Regrade) for a non-submitter", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    await openHub(user)
    expect(
      screen.getByRole("button", { name: "submissions.table.reviewAria" }),
    ).toBeTruthy()
    expect(
      screen.getByRole("button", {
        name: "submissions.table.manageAccessAria",
      }),
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "submissions.rowRegrade.aria" }),
    ).toBeTruthy()
  })

  it("disables the repo-scoped actions for a never-accepted non-submitter", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set()}
      />,
    )
    await openHub(user)
    expect(
      screen
        .getByRole("button", { name: "submissions.table.reviewAria" })
        .hasAttribute("disabled"),
    ).toBe(true)
    expect(
      screen
        .getByRole("button", { name: "submissions.table.manageAccessAria" })
        .hasAttribute("disabled"),
    ).toBe(true)
    expect(
      screen
        .getByRole("button", { name: "submissions.rowRegrade.aria" })
        .hasAttribute("disabled"),
    ).toBe(true)
  })

  it("hides grading actions in the hub for an empty_repo non-submitter but keeps the repo shortcut + download", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        nonSubmitters={[student()]}
        acceptedUsernames={new Set(["alice"])}
        skipsGrading
        emptyRepoAssignment
      />,
    )
    // The Open-repo shortcut stays inline in the row.
    expect(
      screen.getByRole("link", {
        name: "submissions.table.openRepoLabel:cs101-hw1-alice",
      }),
    ).toBeTruthy()
    await openHub(user)
    // empty_repo never autogrades: Review/Manage access/Regrade are hidden in
    // the hub, but Download stays.
    expect(
      screen.queryByRole("button", { name: "submissions.table.reviewAria" }),
    ).toBeNull()
    expect(
      screen.queryByRole("button", { name: "submissions.rowRegrade.aria" }),
    ).toBeNull()
    expect(
      screen.queryByRole("button", {
        name: "submissions.table.manageAccessAria",
      }),
    ).toBeNull()
    expect(
      screen.getByRole("button", { name: "submissions.rowDownload.aria" }),
    ).toBeTruthy()
  })

  it("keeps Review and Manage access in the hub for a no_autograder assignment, hiding only the grading actions", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        scores={[scoreRow()]}
        acceptedUsernames={new Set(["alice"])}
        skipsGrading
      />,
    )
    await openHub(user)
    // no_autograder repos are templated: the Feedback PR and repo access are
    // real, so their actions stay — only the autograding surfaces hide.
    expect(
      screen.getByRole("button", { name: "submissions.table.reviewAria" }),
    ).toBeTruthy()
    expect(
      screen.getByRole("button", {
        name: "submissions.table.manageAccessAria",
      }),
    ).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "submissions.rowRegrade.aria" }),
    ).toBeNull()
  })

  it("shows an em-dash (no Manage trigger) while acceptance data is still loading", () => {
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
    expect(
      screen.queryByRole("button", {
        name: "submissions.manageModal.openAria",
      }),
    ).toBeNull()
  })

  it("renders the hub action list for a group submitter row", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        isGroup
        scores={[scoreRow({ owner: "team-rocket", usernames: ["alice"] })]}
      />,
    )
    await openHub(user)
    // Group rows open the same hub as individual rows, so the
    // Review/Regrade/Download actions are present (parity).
    expect(
      screen.getByRole("button", { name: "submissions.table.reviewAria" }),
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "submissions.rowRegrade.aria" }),
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "submissions.rowDownload.aria" }),
    ).toBeTruthy()
    // The group Members hand-off is present; the per-student Manage-access
    // action is not (group access is managed via the Members modal).
    expect(
      screen.getByRole("button", { name: /submissions\.table\.members/ }),
    ).toBeTruthy()
    expect(
      screen.queryByRole("button", {
        name: "submissions.table.manageAccessAria",
      }),
    ).toBeNull()
  })
})

describe("SubmissionsTable submission details modal", () => {
  it("opens a type-aware details modal from the count chip in tag mode", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        assignmentMode="tag"
        scores={[
          scoreRow({
            submissionCount: 1,
            submissions: [
              {
                datetime: "2026-06-20T10:00:00Z",
                commit: "",
                release: "",
                score: 8,
                "max-score": 10,
              },
            ],
            detectedEntries: [
              { kind: "tag", label: "phase1", count: 1, sha: "aaa1111" },
            ],
          }),
        ]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    // The count chip is always a button; its label is the tag count key.
    await user.click(
      screen.getByRole("button", { name: "submissions.type.countTag" }),
    )
    // The modal lists the tag with a "View tag" link at the tag's tree.
    const view = screen.getByRole("link", {
      name: "submissions.details.viewTag",
    })
    expect(view.getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/phase1",
    )
  })

  it("lists collected tag submissions when the detection overlay is absent (non-owner viewer)", async () => {
    const user = userEvent.setup()
    // A non-owner staff viewer (or the owner before detection resolves) has no
    // detectedEntries, but the collected count is positive. The tag modal must
    // fall back to the collected submissions, not render a false empty state
    // that contradicts the count chip.
    render(
      <SubmissionsTable
        {...baseProps}
        assignmentMode="tag"
        scores={[
          scoreRow({
            submissionCount: 2,
            submissions: [
              {
                datetime: "2026-06-21T10:00:00Z",
                commit: "https://github.com/acme/cs101-hw1-alice/commit/bbb",
                release:
                  "https://github.com/acme/cs101-hw1-alice/releases/tag/submit%2Fz",
                score: 9,
                "max-score": 10,
              },
              {
                datetime: "2026-06-20T10:00:00Z",
                commit: "https://github.com/acme/cs101-hw1-alice/commit/aaa",
                release: "",
                score: 8,
                "max-score": 10,
              },
            ],
            // No detectedEntries: the owner-only overlay never ran for this row.
          }),
        ]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    await user.click(
      screen.getByRole("button", { name: "submissions.type.countTag" }),
    )
    // Not the empty state: the collected submissions render as tag rows.
    expect(screen.queryByText("submissions.details.emptyTag")).toBeNull()
    const tagLinks = screen.getAllByRole("link", {
      name: "submissions.details.viewTag",
    })
    expect(tagLinks).toHaveLength(2)
    // Newest first jumps to its graded release; the one without a release
    // falls back to its commit.
    expect(tagLinks[0].getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice/releases/tag/submit%2Fz",
    )
    expect(tagLinks[1].getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice/commit/aaa",
    )
  })

  it("keeps the tag glob-group modal header consistent with the count chip", async () => {
    const user = userEvent.setup()
    // A submit/* glob group collapses 3 tags into one jumpable row. The chip
    // counts 3 (summed); the modal header must also read 3 (detailItemsCount
    // sums the group's matches), not 1 (one row).
    render(
      <SubmissionsTable
        {...baseProps}
        assignmentMode="tag"
        scores={[
          scoreRow({
            submissionCount: 3,
            submissions: [
              {
                datetime: "2026-06-20T10:00:00Z",
                commit: "",
                release: "",
                score: 8,
                "max-score": 10,
              },
            ],
            detectedEntries: [
              {
                kind: "tag-group",
                label: "submit/*",
                count: 3,
                sha: "aaa1111",
              },
            ],
          }),
        ]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    await user.click(
      screen.getByRole("button", { name: "submissions.type.countTag" }),
    )
    // One jumpable row for the group; the header count is summed from the
    // group's matches (detailItemsCount) rather than the row count, verified by
    // the unit test for detailItemsCount — here we assert the group collapses to
    // a single jump link while remaining openable.
    const tagLinks = screen.getAllByRole("link", {
      name: "submissions.details.viewTag",
    })
    expect(tagLinks).toHaveLength(1)
    expect(tagLinks[0].getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice/tree/aaa1111",
    )
  })

  it("opens each commit for an every-push row", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        assignmentMode="every-push"
        scores={[
          scoreRow({
            submissionCount: 2,
            submissions: [
              {
                datetime: "2026-06-21T10:00:00Z",
                commit: "https://github.com/acme/cs101-hw1-alice/commit/bbb",
                release: "",
                score: 9,
                "max-score": 10,
              },
              {
                datetime: "2026-06-20T10:00:00Z",
                commit: "https://github.com/acme/cs101-hw1-alice/commit/aaa",
                release: "",
                score: 8,
                "max-score": 10,
              },
            ],
          }),
        ]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
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

  it("lists detected pushes in the modal when nothing is collected yet", async () => {
    const user = userEvent.setup()
    // Reproduces the 3-vs-0 bug: the chip counts DETECTED default-branch
    // commits (submissionCount bumped by the detection overlay) while nothing
    // has been collected (submissions empty). The modal must list the detected
    // commits, not 0.
    render(
      <SubmissionsTable
        {...baseProps}
        assignmentMode="every-push"
        scores={[
          scoreRow({
            submissionCount: 3,
            pending: true,
            submissions: [],
            detectedEntries: [
              { kind: "commit", label: "ccc3333", count: 1, sha: "ccc3333" },
              { kind: "commit", label: "bbb2222", count: 1, sha: "bbb2222" },
              { kind: "commit", label: "aaa1111", count: 1, sha: "aaa1111" },
            ],
          }),
        ]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
    await user.click(
      screen.getByRole("button", { name: "submissions.type.countEveryPush" }),
    )
    const commitLinks = screen.getAllByRole("link", {
      name: "submissions.details.viewCommit",
    })
    expect(commitLinks).toHaveLength(3)
    expect(commitLinks[0].getAttribute("href")).toBe(
      "https://github.com/acme/cs101-hw1-alice/commit/ccc3333",
    )
  })

  it("shows the empty state with a tags link when a tag-mode row has no submissions", async () => {
    const user = userEvent.setup()
    render(
      <SubmissionsTable
        {...baseProps}
        assignmentMode="tag"
        scores={[
          scoreRow({
            submissionCount: 0,
            // No detected tags AND no collected submissions: genuinely empty, so
            // the modal shows the empty state rather than the collected-tag
            // fallback (which only fires when collected submissions exist).
            submissions: [],
          }),
        ]}
        acceptedUsernames={new Set(["alice"])}
      />,
    )
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
