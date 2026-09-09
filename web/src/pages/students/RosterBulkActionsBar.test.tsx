// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"

// Direct tests for the selection cluster: what the Actions menu offers per
// selection shape, and — the P1 from the sync-lock review — that the confirm
// modals and run boundaries respect `disabled` even though the modals render
// outside the frozen fieldset.

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "count" in opts ? `${key}:${opts.count}` : key,
    }),
  }
})

// ConfirmModal stub: renders title + a confirm trigger only while open, so
// tests can both assert visibility (the `open && !disabled` gate) and fire
// onConfirm to probe the run boundary.
vi.mock("@/components/modals", () => ({
  ConfirmModal: (props: {
    open: boolean
    title: string
    onConfirm: () => void
  }) =>
    props.open ? (
      <div data-testid="confirm-modal">
        <span>{props.title}</span>
        <button type="button" onClick={props.onConfirm}>
          confirm-run
        </button>
      </div>
    ) : null,
}))

// Defer -> immediate, so a confirmed run executes within the same act().
vi.mock("@/hooks/useDeferredRun", () => ({
  useDeferredRun: () => (fn: () => void | Promise<void>) => fn(),
}))

const bulkUnenrollRoster = vi.fn()
vi.mock("@/domain/roster/bulkUnenrollRoster", () => ({
  bulkUnenrollRoster: (...args: unknown[]) => bulkUnenrollRoster(...args),
}))
const resendClassroomInvite = vi.fn()
const reinviteEmailRows = vi.fn()
const inviteRosterStudents = vi.fn()
const dismissFailedInvitation = vi.fn()
vi.mock("@/domain/students", () => ({
  resendClassroomInvite: (...args: unknown[]) => resendClassroomInvite(...args),
  reinviteEmailRows: (...args: unknown[]) => reinviteEmailRows(...args),
  inviteRosterStudents: (...args: unknown[]) => inviteRosterStudents(...args),
  dismissFailedInvitation: (...args: unknown[]) =>
    dismissFailedInvitation(...args),
  retireEmailInvites: vi.fn(),
  removeUnlinkedRows: vi.fn(),
  unlinkedRowRef: vi.fn(),
}))
vi.mock("@/github-core/mutations", () => ({
  cancelOrgInvitation: vi.fn(),
}))

import RosterBulkActionsBar from "./RosterBulkActionsBar"
import type { TeamRosterRow } from "@/util/teamRoster"
import type { GitHubClient } from "@/github-core/client"

const row = (over: Partial<TeamRosterRow>): TeamRosterRow => ({
  key: over.username || over.email || "k",
  state: "enrolled",
  roles: ["student"],
  username: "",
  github_id: "",
  first_name: "",
  last_name: "",
  section: "",
  email: "",
  avatar_url: "",
  ...over,
})

const enrolled = row({ username: "ada", github_id: "1", state: "enrolled" })
const pending = row({
  username: "grace",
  github_id: "2",
  state: "pending",
  invitation_id: 42,
})
// The rows the teacher in #921 had: an email-only pending invite, an unlinked
// address whose invitation expired, and a not-in-org account whose invitation
// expired. Each is invitable in its own lane.
const pendingEmail = row({
  email: "pend@x.edu",
  state: "pending",
  invitation_id: 43,
})
const expiredEmail = row({
  key: "unlinked:grace.hopper@x.edu",
  email: "grace.hopper@x.edu",
  state: "unlinked",
  failed_invitation: {
    id: 79153766,
    kind: "expired",
    failed_at: null,
    reason: null,
  },
})
const nameOnlyUnlinked = row({ key: "unlinked:x", state: "unlinked" })
const expiredLogin = row({
  username: "monalisa",
  state: "needs_attention_not_in_org",
  failed_invitation: {
    id: 79153763,
    kind: "expired",
    failed_at: null,
    reason: null,
  },
})

const renderBar = (
  selectedRows: TeamRosterRow[],
  {
    disabled = false,
    onClearSelection = vi.fn(),
    onDone = vi.fn(),
  }: {
    disabled?: boolean
    onClearSelection?: () => void
    onDone?: () => void
  } = {},
) =>
  render(
    <RosterBulkActionsBar
      org="acme"
      classroom="cs101"
      client={{} as GitHubClient}
      selectedRows={selectedRows}
      onClearSelection={onClearSelection}
      onDone={onDone}
      disabled={disabled}
    />,
  )

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("RosterBulkActionsBar — selection cluster", () => {
  it("renders no cluster while no rows are selected", () => {
    renderBar([])
    // The (always-mounted) result modal is closed; the cluster itself is gone.
    expect(screen.queryByText("common.actions")).toBeNull()
    expect(screen.queryByText(/students\.bulk\.selectedCount/)).toBeNull()
  })

  it("shows the count, the Actions menu, and Clear when rows are selected", () => {
    const onClearSelection = vi.fn()
    renderBar([enrolled], { onClearSelection })
    expect(screen.getByText("students.bulk.selectedCount:1")).not.toBeNull()
    expect(screen.getByText("common.actions")).not.toBeNull()
    fireEvent.click(screen.getByLabelText("common.clearSelection"))
    expect(onClearSelection).toHaveBeenCalled()
  })

  it("enables each action only for the selection shapes it can act on", () => {
    renderBar([enrolled])
    const invite = screen
      .getByText("students.bulk.invite")
      .closest("button") as HTMLButtonElement
    const cancel = screen
      .getByText("students.bulk.cancelInvite")
      .closest("button") as HTMLButtonElement
    const unenroll = screen
      .getByText("students.bulk.unenroll")
      .closest("button") as HTMLButtonElement
    // An enrolled row: unenrollable, but not invitable/cancellable.
    expect(invite.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)
    expect(unenroll.disabled).toBe(false)
  })

  it("opens the unenroll confirm from the menu and runs on confirm", async () => {
    bulkUnenrollRoster.mockResolvedValue({ outcomes: [] })
    renderBar([enrolled])
    fireEvent.click(screen.getByText("students.bulk.unenroll"))
    expect(screen.getByTestId("confirm-modal")).not.toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByText("confirm-run"))
    })
    expect(bulkUnenrollRoster).toHaveBeenCalledTimes(1)
  })

  it("freezes every control inside the fieldset while disabled", () => {
    renderBar([enrolled, pending], { disabled: true })
    const fieldset = screen
      .getByText("common.actions")
      .closest("fieldset") as HTMLFieldSetElement
    expect(fieldset.disabled).toBe(true)
  })

  it("hides an already-open confirm when disabled arms (the sync lock)", () => {
    const { rerender } = renderBar([enrolled])
    fireEvent.click(screen.getByText("students.bulk.unenroll"))
    expect(screen.getByTestId("confirm-modal")).not.toBeNull()
    rerender(
      <RosterBulkActionsBar
        org="acme"
        classroom="cs101"
        client={{} as GitHubClient}
        selectedRows={[enrolled]}
        onClearSelection={vi.fn()}
        onDone={vi.fn()}
        disabled
      />,
    )
    expect(screen.queryByTestId("confirm-modal")).toBeNull()
    // Unfreezing brings the pending confirm back (state was kept, not lost) —
    // the teacher re-confirms after the sync lands instead of re-navigating.
    rerender(
      <RosterBulkActionsBar
        org="acme"
        classroom="cs101"
        client={{} as GitHubClient}
        selectedRows={[enrolled]}
        onClearSelection={vi.fn()}
        onDone={vi.fn()}
      />,
    )
    expect(screen.getByTestId("confirm-modal")).not.toBeNull()
    expect(bulkUnenrollRoster).not.toHaveBeenCalled()
  })
})

describe("RosterBulkActionsBar — send invitations", () => {
  const inviteButton = () =>
    screen
      .getByText("students.bulk.invite")
      .closest("button") as HTMLButtonElement

  it("is enabled for every row that can receive a fresh invite, and only those", () => {
    // Each lane on its own.
    for (const rows of [
      [pending],
      [pendingEmail],
      [expiredEmail],
      [expiredLogin],
    ]) {
      renderBar(rows)
      expect(inviteButton().disabled).toBe(false)
      cleanup()
    }
    // A name-only unlinked row has nowhere to send an invitation.
    renderBar([nameOnlyUnlinked])
    expect(inviteButton().disabled).toBe(true)
  })

  it("counts the mixed selection across lanes in the menu title", () => {
    renderBar([enrolled, pending, pendingEmail, expiredEmail, expiredLogin])
    expect(inviteButton().title).toBe("students.bulk.inviteSelected:4")
  })

  it("routes each row to its lane with the ids the recipe must clear first", async () => {
    resendClassroomInvite.mockResolvedValue({ state: "invited" })
    reinviteEmailRows.mockResolvedValue({
      invited: [{ email: "pend@x.edu", role: "student" }],
      skipped: [{ email: "grace.hopper@x.edu" }],
      failed: [],
      deferred: [],
    })
    inviteRosterStudents.mockResolvedValue({
      invited: [{ username: "monalisa", role: "student" }],
      skipped: [],
      failed: [],
      deferred: [],
    })
    const onDone = vi.fn()
    renderBar([pending, pendingEmail, expiredEmail, expiredLogin], { onDone })

    fireEvent.click(inviteButton())
    await act(async () => {
      fireEvent.click(screen.getByText("confirm-run"))
    })

    // Lane 1: the login resend, by id.
    expect(resendClassroomInvite).toHaveBeenCalledTimes(1)
    expect(resendClassroomInvite.mock.calls[0]?.[1]).toMatchObject({
      username: "grace",
      inviteeId: 2,
      invitationId: 42,
    })
    // Lane 2: both email rows in ONE batch, the pending one carrying its live
    // invitation id and the expired one its failed record.
    expect(reinviteEmailRows).toHaveBeenCalledTimes(1)
    expect(reinviteEmailRows.mock.calls[0]?.[1]).toMatchObject({
      org: "acme",
      classroom: "cs101",
      targets: [
        { email: "pend@x.edu", role: "student", pendingInvitationId: 43 },
        {
          email: "grace.hopper@x.edu",
          role: "student",
          failedInvitationId: 79153766,
        },
      ],
    })
    // Lane 3: the expired login's record is dismissed, then a fresh invite.
    expect(dismissFailedInvitation).toHaveBeenCalledWith(expect.anything(), {
      org: "acme",
      invitationId: 79153763,
    })
    expect(inviteRosterStudents.mock.calls[0]?.[1]).toMatchObject({
      students: [{ username: "monalisa", role: "student" }],
    })
    expect(onDone).toHaveBeenCalledWith("invite")
  })
})
