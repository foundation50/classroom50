// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { count?: number }) =>
        opts?.count === undefined ? key : `${key}:${opts.count}`,
    }),
  }
})

vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify, dismiss: vi.fn() }),
}))
vi.mock("@/components/modals/BulkReuseAssignmentsModal", () => ({
  BulkReuseAssignmentsModal: ({ onClose }: { onClose: () => void }) => (
    <div>
      <button onClick={() => onClose()}>dismiss-reuse</button>
    </div>
  ),
}))
// Typed by signature so the recorded argument stays indexable.
type LockArgs = { slugs: string[]; locked: boolean }
const { notify } = vi.hoisted(() => ({
  notify: vi.fn<(t: { message: string }) => void>(),
}))
const lockMutate = vi.fn<(args: LockArgs) => Promise<unknown>>()
const deleteMutate = vi.fn<(args: { slugs: string[] }) => Promise<unknown>>()
vi.mock("@/hooks/mutations/useBulkAssignmentActions", () => ({
  useBulkSetAssignmentLock: () => ({
    mutateAsync: lockMutate,
    isPending: false,
  }),
  useBulkDeleteAssignments: () => ({
    mutateAsync: deleteMutate,
    isPending: false,
  }),
}))

import { AssignmentsBulkBar } from "./AssignmentsBulkBar"
import type { Assignment } from "@/types/classroom"

const assignment = (slug: string, locked = false) =>
  ({ slug, name: slug, locked }) as Assignment
const ALL = [
  assignment("hw1"),
  assignment("hw2"),
  assignment("hw3", true),
  assignment("hw4"),
]

const renderBar = (props: { selected: string[] }) =>
  render(
    <AssignmentsBulkBar
      org="acme"
      classroom="cs50"
      selected={ALL.filter((a) => props.selected.includes(a.slug))}
      onClearSelection={() => {}}
    />,
  )

beforeEach(() => {
  deleteMutate
    .mockReset()
    .mockResolvedValue({ deleted: ["hw1"], missing: [], newCommitSha: "sha" })
  notify.mockReset()
  lockMutate.mockReset().mockResolvedValue({
    changed: [],
    missing: [],
    outcomes: [],
    newCommitSha: null,
  })
  // happy-dom's <dialog> has no showModal/close; the confirm modal's
  // open-sync effect needs them.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
    this.dispatchEvent(new Event("close"))
  }
})
afterEach(cleanup)

describe("AssignmentsBulkBar selection scope", () => {
  // A selected row the search is hiding is still acted on.
  it("counts the whole selection, not only the visible rows", () => {
    renderBar({ selected: ["hw1", "hw2", "hw3"] })

    expect(screen.getByText("assignments.bulk.selectedCount:3")).toBeTruthy()
  })

  it("acts on the whole selection while a search narrows the table", async () => {
    renderBar({ selected: ["hw1", "hw3"] })

    // The toolbar control is an icon button (label via aria-label); the
    // confirm dialog's button carries the same string as visible text.
    fireEvent.click(screen.getByLabelText("assignments.bulk.lock"))
    fireEvent.click(screen.getByText("assignments.bulk.lock"))

    await vi.waitFor(() => expect(lockMutate).toHaveBeenCalled())
    expect(lockMutate.mock.calls[0][0]).toEqual({
      slugs: ["hw1", "hw3"],
      locked: true,
    })
  })
})

// A selection can be mixed, so both verbs exist; one with nothing to do is
// disabled.
describe("AssignmentsBulkBar lock state", () => {
  const lockButton = () =>
    screen.getByLabelText("assignments.bulk.lock") as HTMLButtonElement
  const unlockButton = () =>
    screen.getByLabelText("assignments.bulk.unlock") as HTMLButtonElement

  it("offers both verbs on a mixed selection", () => {
    renderBar({ selected: ["hw1", "hw3"] })

    expect(lockButton().disabled).toBe(false)
    expect(unlockButton().disabled).toBe(false)
  })

  it("disables Lock when everything selected is already locked", () => {
    renderBar({ selected: ["hw3"] })

    expect(lockButton().disabled).toBe(true)
    expect(lockButton().getAttribute("title")).toBe(
      "assignments.bulk.lockAllLocked",
    )
    expect(unlockButton().disabled).toBe(false)
  })

  it("disables Unlock when nothing selected is locked", () => {
    renderBar({ selected: ["hw1", "hw2"] })

    expect(unlockButton().disabled).toBe(true)
    expect(unlockButton().getAttribute("title")).toBe(
      "assignments.bulk.unlockNoneLocked",
    )
    expect(lockButton().disabled).toBe(false)
  })
})

// No bulk action clears the selection: the dialogs live in the head cell a
// selection keeps mounted, so clearing from inside one would destroy it
// mid-close.
describe("AssignmentsBulkBar selection lifetime", () => {
  const openReuse = () =>
    fireEvent.click(screen.getByLabelText("assignments.bulk.reuse"))

  it("keeps the selection after a bulk lock lands", async () => {
    const onClearSelection = vi.fn()
    render(
      <AssignmentsBulkBar
        org="acme"
        classroom="cs50"
        selected={ALL.filter((a) => ["hw1", "hw2"].includes(a.slug))}
        onClearSelection={onClearSelection}
      />,
    )

    fireEvent.click(screen.getByLabelText("assignments.bulk.lock"))
    fireEvent.click(screen.getByText("assignments.bulk.lock"))

    await vi.waitFor(() => expect(lockMutate).toHaveBeenCalled())
    expect(onClearSelection).not.toHaveBeenCalled()
  })

  it("keeps the selection after a bulk delete lands", async () => {
    const onClearSelection = vi.fn()
    render(
      <AssignmentsBulkBar
        org="acme"
        classroom="cs50"
        selected={ALL.filter((a) => ["hw1"].includes(a.slug))}
        onClearSelection={onClearSelection}
      />,
    )

    fireEvent.click(screen.getByLabelText("assignments.bulk.delete"))
    // Delete acknowledges first, then wants the word typed.
    fireEvent.click(screen.getByText("components.confirmModal.yesContinue"))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "assignments.bulk.deleteConfirmWord" },
    })
    fireEvent.click(screen.getByText("assignments.bulk.delete"))

    await vi.waitFor(() => expect(deleteMutate).toHaveBeenCalled())
    expect(onClearSelection).not.toHaveBeenCalled()
  })

  // "Already in that state" would be false for assignments that no longer
  // exist; notifyMissing reports them instead.
  it("does not claim no-change when the whole selection was already gone", async () => {
    lockMutate.mockResolvedValue({
      changed: [],
      missing: ["hw1"],
      outcomes: [],
      newCommitSha: null,
    })
    renderBar({ selected: ["hw1"] })

    fireEvent.click(screen.getByLabelText("assignments.bulk.lock"))
    fireEvent.click(screen.getByText("assignments.bulk.lock"))

    await vi.waitFor(() => expect(lockMutate).toHaveBeenCalled())
    const messages = notify.mock.calls.map((c) => c[0].message)
    expect(messages).toContain("assignments.bulk.missingSkipped:1")
    expect(messages).not.toContain("assignments.bulk.lockNoChange")
  })

  it("keeps the selection when the reuse dialog is dismissed", () => {
    const onClearSelection = vi.fn()
    render(
      <AssignmentsBulkBar
        org="acme"
        classroom="cs50"
        selected={ALL.filter((a) => ["hw1"].includes(a.slug))}
        onClearSelection={onClearSelection}
      />,
    )

    openReuse()
    fireEvent.click(screen.getByText("dismiss-reuse"))
    expect(onClearSelection).not.toHaveBeenCalled()
  })
})
