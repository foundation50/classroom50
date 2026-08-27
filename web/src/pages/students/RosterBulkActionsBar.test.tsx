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
vi.mock("@/domain/students", () => ({
  resendClassroomInvite: vi.fn(),
  retireEmailInvites: vi.fn(),
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
    expect(screen.queryByText("students.bulk.actions")).toBeNull()
    expect(screen.queryByText(/students\.bulk\.selectedCount/)).toBeNull()
  })

  it("shows the count, the Actions menu, and Clear when rows are selected", () => {
    const onClearSelection = vi.fn()
    renderBar([enrolled], { onClearSelection })
    expect(screen.getByText("students.bulk.selectedCount:1")).not.toBeNull()
    expect(screen.getByText("students.bulk.actions")).not.toBeNull()
    fireEvent.click(screen.getByLabelText("students.bulk.clearSelection"))
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
      .getByText("students.bulk.actions")
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
