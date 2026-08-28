// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"

// Direct tests for the members selection cluster's destructive routing: which
// orchestrator each menu route dispatches — classroom remove, the #664
// escalation checkbox (remove-org over the FULL selection), and the direct
// org action — plus the per-open checkbox reset and the disabled remove entry
// when nobody in the selection is removable.

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

// ConfirmModal stub: renders children (the picker/checkbox slot) plus a
// confirm trigger while open, honoring confirmDisabled — routing is under
// test here; the real modal's step machinery has its own tests.
vi.mock("@/components/modals", () => ({
  ConfirmModal: (props: {
    open: boolean
    title: string
    confirmDisabled?: boolean
    onConfirm: () => void
    children?: React.ReactNode
  }) =>
    props.open ? (
      <div data-testid="confirm-modal">
        <span>{props.title}</span>
        {props.children}
        <button
          type="button"
          disabled={props.confirmDisabled}
          onClick={props.onConfirm}
        >
          confirm-run
        </button>
      </div>
    ) : null,
}))

// Defer -> immediate, so a confirmed run executes within the same act().
vi.mock("@/hooks/useDeferredRun", () => ({
  useDeferredRun: () => (fn: () => void | Promise<void>) => fn(),
}))

const bulkAddToClassroom = vi.fn()
vi.mock("@/domain/orgMembers/bulkAddToClassroom", () => ({
  bulkAddToClassroom: (...args: unknown[]) => bulkAddToClassroom(...args),
}))
const bulkRemoveFromClassroom = vi.fn()
vi.mock("@/domain/orgMembers/bulkRemoveFromClassroom", () => ({
  bulkRemoveFromClassroom: (...args: unknown[]) =>
    bulkRemoveFromClassroom(...args),
}))
const bulkRemoveFromOrg = vi.fn()
vi.mock("@/domain/orgMembers/bulkRemoveFromOrg", () => ({
  bulkRemoveFromOrg: (...args: unknown[]) => bulkRemoveFromOrg(...args),
}))

import BulkActionsBar from "./BulkActionsBar"
import type { OrgMemberRow } from "@/util/orgMembers"
import type { GitHubClient } from "@/github-core/client"

const row = (over: Partial<OrgMemberRow>): OrgMemberRow => ({
  key: over.username || over.email || "k",
  username: "",
  github_id: "",
  name: "",
  email: "",
  emails: [],
  isMember: true,
  classrooms: [],
  classification: "member-on-roster",
  unprovisionedClassrooms: [],
  ...over,
})

const access = (classroom: string) => ({
  classroom,
  archived: false,
  section: "",
  state: "enrolled" as const,
})

const ada = row({
  username: "ada",
  github_id: "1",
  classrooms: [access("cs101")],
})
const grace = row({ username: "grace", github_id: "2", classrooms: [] })

const CLASSROOMS = [
  { name: "CS 101", path: "cs101" },
  { name: "CS 201", path: "cs201" },
]

const renderBar = (
  selectedRows: OrgMemberRow[],
  { onDone = vi.fn() }: { onDone?: () => void } = {},
) =>
  render(
    <BulkActionsBar
      org="acme"
      client={{} as GitHubClient}
      selectedRows={selectedRows}
      members={[]}
      classrooms={CLASSROOMS}
      onClearSelection={vi.fn()}
      onDone={onDone}
    />,
  )

const openRemoveConfirm = () => {
  fireEvent.click(
    screen.getByText("orgMembers.bulk.removeFromClassroomMenu", {
      selector: "button",
    }),
  )
}

const confirmRun = async () => {
  await act(async () => {
    fireEvent.click(screen.getByText("confirm-run"))
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("BulkActionsBar — destructive routing", () => {
  it("classroom remove dispatches bulkRemoveFromClassroom, never the org orchestrator", async () => {
    bulkRemoveFromClassroom.mockResolvedValue({
      outcomes: [],
      removedCount: 0,
      warnings: [],
    })
    const onDone = vi.fn()
    renderBar([ada], { onDone })

    openRemoveConfirm()
    await confirmRun()

    expect(bulkRemoveFromClassroom).toHaveBeenCalledTimes(1)
    expect(bulkRemoveFromClassroom.mock.calls[0][1]).toMatchObject({
      org: "acme",
      classroom: "cs101",
      rows: [ada],
    })
    expect(bulkRemoveFromOrg).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ action: "remove", classroom: "cs101" }),
    )
  })

  it("the escalation checkbox reroutes the confirmed run to bulkRemoveFromOrg with the FULL selection", async () => {
    bulkRemoveFromOrg.mockResolvedValue({
      outcomes: [
        {
          key: "ada",
          label: "ada",
          status: "removed",
          unenrolledClassrooms: ["cs101"],
        },
        {
          key: "grace",
          label: "grace",
          status: "failed",
          detail: "boom",
          unenrolledClassrooms: ["cs201"],
        },
      ],
      removedCount: 1,
      warnings: [],
    })
    const onDone = vi.fn()
    // grace is not on the picked classroom but IS in the selection: the
    // escalated run must still include her.
    renderBar([ada, grace], { onDone })

    openRemoveConfirm()
    fireEvent.click(screen.getByRole("checkbox"))
    await confirmRun()

    expect(bulkRemoveFromOrg).toHaveBeenCalledTimes(1)
    expect(bulkRemoveFromOrg.mock.calls[0][1]).toMatchObject({
      org: "acme",
      rows: [ada, grace],
    })
    expect(bulkRemoveFromClassroom).not.toHaveBeenCalled()
    // onDone carries removed-only keys plus every ACTUAL unenroll (failed
    // rows included — their rosters changed before the DELETE failed).
    expect(onDone).toHaveBeenCalledWith({
      action: "remove-org",
      affectedKeys: ["ada"],
      unenrolled: [
        { key: "ada", classrooms: ["cs101"] },
        { key: "grace", classrooms: ["cs201"] },
      ],
    })
  })

  it("the direct org action dispatches bulkRemoveFromOrg with no escalation checkbox offered", async () => {
    bulkRemoveFromOrg.mockResolvedValue({
      outcomes: [],
      removedCount: 0,
      warnings: [],
    })
    renderBar([ada, grace])

    fireEvent.click(
      screen.getByText("orgMembers.removeFromOrg", { selector: "button" }),
    )
    expect(screen.queryByRole("checkbox")).toBeNull()
    await confirmRun()

    expect(bulkRemoveFromOrg).toHaveBeenCalledTimes(1)
    expect(bulkRemoveFromClassroom).not.toHaveBeenCalled()
  })

  it("resets the escalation checkbox on every fresh open", () => {
    renderBar([ada])

    openRemoveConfirm()
    const checkbox = () => screen.getByRole("checkbox") as HTMLInputElement
    fireEvent.click(checkbox())
    expect(checkbox().checked).toBe(true)

    // Close (onClose) and re-open through the menu: the escalation must be a
    // fresh decision, never remembered from the previous confirm.
    cleanup()
    renderBar([ada])
    openRemoveConfirm()
    expect(checkbox().checked).toBe(false)
  })

  it("disables the classroom-remove entry when no selected member is on any classroom", () => {
    renderBar([grace])

    const entry = screen.getByText("orgMembers.bulk.removeFromClassroomMenu", {
      selector: "button",
    }) as HTMLButtonElement
    expect(entry.disabled).toBe(true)
    // The org-wide route stays available for roster-less members.
    const orgEntry = screen.getByText("orgMembers.removeFromOrg", {
      selector: "button",
    }) as HTMLButtonElement
    expect(orgEntry.disabled).toBe(false)
  })
})
