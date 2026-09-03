// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
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

// Only the hub's own composition/hand-off is under test; the per-action hooks
// and detail reads are stubbed so no GitHub/provider wiring is needed.
const repoData = vi.fn(
  () => ({ data: undefined }) as { data: unknown; isLoading?: boolean },
)
const collaboratorsData = vi.fn(
  () => ({ data: undefined }) as { data: unknown; isLoading?: boolean },
)
const autogradeStateData = vi.fn(
  () =>
    ({ data: undefined, isLoading: false, isError: false }) as {
      data: unknown
      isLoading?: boolean
      isError?: boolean
    },
)
vi.mock("@/hooks/useGetRepo", () => ({
  default: () => repoData(),
}))
vi.mock("@/hooks/useGetRepoCollaborators", () => ({
  default: () => collaboratorsData(),
}))
vi.mock("@/hooks/useGetAutogradeState", () => ({
  default: () => autogradeStateData(),
}))
// The setup-marker probe, configurable so a test can drive the issue #502
// "Incomplete" badge.
const repoSetupData = vi.fn(
  () =>
    ({ state: "complete", isLoading: false }) as {
      state: "unknown" | "complete" | "incomplete"
      isLoading: boolean
    },
)
vi.mock("@/hooks/useAssignmentRepoSetup", () => ({
  default: () => repoSetupData(),
}))
vi.mock("@/hooks/mutations/useSetAutogradeState", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock("@/hooks/useGetFeedbackPr", () => ({
  default: () => ({ refetch: vi.fn() }),
}))
vi.mock("@/hooks/mutations/useRepairFeedbackPr", () => ({
  default: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify: notifyMock, announce: vi.fn() }),
}))
vi.mock("@/hooks/useTriggerRegrade", () => ({
  default: () => ({ regrade: vi.fn(), phase: "idle", anyRegrading: false }),
}))
vi.mock("@/hooks/mutations/useDownloadSubmission", () => ({
  default: () => ({ mutate: downloadMutate, isPending: false }),
}))

const notifyMock = vi.fn()
// Configurable so tests can drive the download row's onError into the hub
// feedback channel.
const downloadMutate = vi.fn()

import { ManageSubmissionModal } from "./ManageSubmissionModal"

const individualAction = {
  mode: "individual" as const,
  org: "acme",
  classroom: "cs101",
  assignment: "hw1",
  owner: "alice",
  repo: "cs101-hw1-alice",
  hasRepo: true,
  skipsGrading: false,
  emptyRepoAssignment: false,
}

afterEach(() => {
  cleanup()
  notifyMock.mockClear()
  downloadMutate.mockReset()
  repoData.mockReturnValue({ data: undefined })
  collaboratorsData.mockReturnValue({ data: undefined })
  autogradeStateData.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  })
  repoSetupData.mockReturnValue({ state: "complete", isLoading: false })
})

describe("ManageSubmissionModal", () => {
  it("shows accept/push time, owner access, and hides collaborators when the owner is alone", () => {
    repoData.mockReturnValue({
      data: {
        created_at: "2026-06-01T09:00:00Z",
        pushed_at: "2026-06-20T10:00:00Z",
        html_url: "https://github.com/acme/cs101-hw1-alice",
        default_branch: "main",
      },
    })
    collaboratorsData.mockReturnValue({
      data: [
        {
          login: "alice",
          permissions: {
            admin: false,
            maintain: false,
            push: true,
            pull: true,
          },
        },
      ],
    })
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={{ ...individualAction, onManageAccess: vi.fn() }}
      />,
    )
    expect(screen.getByText("submissions.manageModal.accepted")).toBeTruthy()
    expect(screen.getByText("submissions.manageModal.lastPush")).toBeTruthy()
    // Owner is push -> Write (push) level label.
    expect(
      screen.getByText("assignments.form.studentPermission.levels.push"),
    ).toBeTruthy()
    // Only the owner is a collaborator, so the collaborators line is hidden.
    expect(
      screen.queryByText("submissions.manageModal.collaborators"),
    ).toBeNull()
    // Both the commit action and the Last-push value link to the default-branch
    // tip (the literal latest commit).
    const latest = "https://github.com/acme/cs101-hw1-alice/commit/main"
    const commitLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === latest)
    expect(commitLinks.length).toBe(2)
  })

  // Issue #502: "Accepted" is only repo existence. When the marker probe says
  // the setup commit never landed, the hub says so next to the timestamp and
  // tells the teacher what the student must do.
  it("flags an accepted repo whose setup never finished", () => {
    repoData.mockReturnValue({
      data: { created_at: "2026-07-22T21:42:00Z" },
    })
    repoSetupData.mockReturnValue({ state: "incomplete", isLoading: false })
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={individualAction}
      />,
    )
    expect(screen.getByText("submissions.manageModal.accepted")).toBeTruthy()
    expect(screen.getByText("submissions.manageModal.setup")).toBeTruthy()
    expect(
      screen.getByText("submissions.manageModal.setupIncomplete"),
    ).toBeTruthy()
    expect(
      screen.getByText("submissions.manageModal.setupIncompleteHint"),
    ).toBeTruthy()
  })

  it("shows no setup row for a healthy repo", () => {
    repoData.mockReturnValue({
      data: { created_at: "2026-06-01T09:00:00Z" },
    })
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={individualAction}
      />,
    )
    expect(screen.queryByText("submissions.manageModal.setup")).toBeNull()
    expect(
      screen.queryByText("submissions.manageModal.setupIncompleteHint"),
    ).toBeNull()
  })

  it("shows the autograding status when the assignment autogrades", () => {
    repoData.mockReturnValue({
      data: { created_at: "2026-06-01T09:00:00Z" },
    })
    autogradeStateData.mockReturnValue({
      data: "enabled",
      isLoading: false,
      isError: false,
    })
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={{ ...individualAction, canPauseAutograding: true }}
      />,
    )
    expect(screen.getByText("submissions.manageModal.autograding")).toBeTruthy()
    expect(
      screen.getByText("submissions.manageModal.autogradingEnabled"),
    ).toBeTruthy()
  })

  it("labels a disabled workflow as paused", () => {
    repoData.mockReturnValue({
      data: { created_at: "2026-06-01T09:00:00Z" },
    })
    autogradeStateData.mockReturnValue({
      data: "paused",
      isLoading: false,
      isError: false,
    })
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={{ ...individualAction, canPauseAutograding: true }}
      />,
    )
    expect(
      screen.getByText("submissions.manageModal.autogradingPaused"),
    ).toBeTruthy()
  })

  it("omits the autograding status for a non-autograding assignment", () => {
    repoData.mockReturnValue({
      data: { created_at: "2026-06-01T09:00:00Z" },
    })
    // Even if a state somehow resolved, the row is gated on canPauseAutograding.
    autogradeStateData.mockReturnValue({
      data: "enabled",
      isLoading: false,
      isError: false,
    })
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={{ ...individualAction }}
      />,
    )
    expect(screen.queryByText("submissions.manageModal.autograding")).toBeNull()
  })

  it("falls the commit action back to the graded snapshot when the default-branch tip is unresolved", () => {
    // repoData lacks html_url/default_branch, so latestCommitHref is undefined;
    // the commit action falls back to the scores.json `commit` URL.
    repoData.mockReturnValue({
      data: { created_at: "2026-06-01T09:00:00Z" },
    })
    const graded = "https://github.com/acme/cs101-hw1-alice/commit/abc123"
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={{
          ...individualAction,
          commit: graded,
          onManageAccess: vi.fn(),
        }}
      />,
    )
    expect(
      screen
        .getAllByRole("link")
        .some((a) => a.getAttribute("href") === graded),
    ).toBe(true)
  })

  it("disables the commit action when neither the tip nor a graded commit exists", () => {
    // No repo tip and no scores.json commit: the row is a disabled button with
    // the no-commit description rather than a link.
    repoData.mockReturnValue({ data: { created_at: "2026-06-01T09:00:00Z" } })
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={{ ...individualAction, commit: null, onManageAccess: vi.fn() }}
      />,
    )
    const commitRow = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("submissions.table.viewCommit"))
    expect(commitRow).toBeTruthy()
    expect(commitRow?.hasAttribute("disabled")).toBe(true)
    expect(commitRow?.textContent).toContain("submissions.table.noCommit")
  })

  it("lists collaborators beyond the owner (e.g. a group repo)", () => {
    collaboratorsData.mockReturnValue({
      data: [
        {
          login: "alice",
          permissions: { admin: true, maintain: true, push: true, pull: true },
        },
        {
          login: "bob",
          permissions: {
            admin: false,
            maintain: false,
            push: true,
            pull: true,
          },
        },
      ],
    })
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="cs101-hw1-team"
        repo="cs101-hw1-team"
        isGroup
        students={[]}
        onManageMembers={vi.fn()}
        action={{
          ...individualAction,
          mode: "group",
          owner: "alice",
          repo: "cs101-hw1-team",
        }}
      />,
    )
    expect(
      screen.getByText("submissions.manageModal.collaborators"),
    ).toBeTruthy()
    expect(screen.getByText("@bob")).toBeTruthy()
  })

  it("shows a skeleton while the repo/collaborator reads are in flight", () => {
    repoData.mockReturnValue({ data: undefined, isLoading: true })
    collaboratorsData.mockReturnValue({ data: undefined, isLoading: true })
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={{ ...individualAction, onManageAccess: vi.fn() }}
      />,
    )
    expect(document.querySelector(".skeleton")).toBeTruthy()
    expect(screen.getByText("common.loading")).toBeTruthy()
  })

  it("opens the access editor stacked on the hub, leaving the hub open", async () => {
    const user = userEvent.setup()
    const onManageAccess = vi.fn()
    const onClose = vi.fn()
    render(
      <ManageSubmissionModal
        onClose={onClose}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={{ ...individualAction, onManageAccess }}
      />,
    )
    await user.click(
      screen.getByRole("button", {
        name: "submissions.table.manageAccessAria",
      }),
    )
    // Stacked, not a hand-off: the editor opens (via the callback) while the hub
    // stays open, so dismissing the editor returns here rather than closing all.
    expect(onManageAccess).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("hides its own box while a stacked sub-modal is open", () => {
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        repoHref="https://github.com/acme/cs101-hw1-alice"
        isGroup={false}
        students={[]}
        subModalOpen
        action={{ ...individualAction, onManageAccess: vi.fn() }}
      />,
    )
    // The hub's dialog stays open (returns focus on editor close) but its box is
    // hidden so the two modal boxes don't visibly layer.
    const box = document.querySelector(".modal-box")
    expect(box?.className).toContain("invisible")
  })

  it("offers the group members hand-off and omits per-student access", async () => {
    const user = userEvent.setup()
    const onManageMembers = vi.fn()
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="cs101-hw1-team"
        repo="cs101-hw1-team"
        repoHref="https://github.com/acme/cs101-hw1-team"
        isGroup
        students={[]}
        onManageMembers={onManageMembers}
        action={{
          ...individualAction,
          mode: "group",
          owner: "team",
          repo: "cs101-hw1-team",
        }}
      />,
    )
    expect(
      screen.queryByRole("button", {
        name: "submissions.table.manageAccessAria",
      }),
    ).toBeNull()
    const manageGroup = screen.getByRole("button", {
      name: /submissions\.manageModal\.manageGroup/,
    })
    // The manage-group hand-off leads the hub's action list.
    const actionButtons = screen
      .getAllByRole("button")
      .filter((b) => b.closest(".divide-y"))
    expect(actionButtons[0]).toBe(manageGroup)
    await user.click(manageGroup)
    expect(onManageMembers).toHaveBeenCalledOnce()
  })

  it("disables the repo-scoped actions when no repo exists yet", () => {
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={{
          ...individualAction,
          hasRepo: false,
          onManageAccess: vi.fn(),
        }}
      />,
    )
    expect(
      screen
        .getByRole("button", { name: "submissions.rowDownload.aria" })
        .hasAttribute("disabled"),
    ).toBe(true)
    expect(
      screen
        .getByRole("button", { name: "submissions.table.reviewAria" })
        .hasAttribute("disabled"),
    ).toBe(true)
  })
})

// The hub feedback channel: an action row's outcome renders as a banner
// inside the open hub; an outcome landing after the hub unmounts (closed
// mid-action) falls back to a toast instead of vanishing.
describe("ManageSubmissionModal — action feedback channel", () => {
  const renderHub = () =>
    render(
      <ManageSubmissionModal
        onClose={vi.fn()}
        title="Alice"
        repo="cs101-hw1-alice"
        isGroup={false}
        students={[]}
        action={individualAction}
      />,
    )

  it("renders an action failure as an in-hub banner, not a toast", () => {
    // The download row reports failures through its mutate onError callback.
    downloadMutate.mockImplementation(
      (_vars: unknown, opts?: { onError?: (err: Error) => void }) => {
        opts?.onError?.(new Error("boom"))
      },
    )
    renderHub()
    fireEvent.click(
      screen.getByRole("button", { name: "submissions.rowDownload.aria" }),
    )

    expect(screen.getByText("submissions.rowDownload.error")).toBeTruthy()
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it("falls back to a toast when the outcome lands after the hub unmounted", () => {
    // Capture the onError callback so it can fire post-unmount (a slow write
    // settling after the teacher closed the hub).
    let lateError: ((err: Error) => void) | undefined
    downloadMutate.mockImplementation(
      (_vars: unknown, opts?: { onError?: (err: Error) => void }) => {
        lateError = opts?.onError
      },
    )
    const view = renderHub()
    fireEvent.click(
      screen.getByRole("button", { name: "submissions.rowDownload.aria" }),
    )
    view.unmount()

    act(() => {
      lateError?.(new Error("boom"))
    })
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: "error",
        message: "submissions.rowDownload.error",
      }),
    )
  })
})
