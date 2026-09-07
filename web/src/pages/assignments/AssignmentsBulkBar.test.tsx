// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"

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
  useBulkReuseAssignments: () => ({
    running: false,
    processed: 0,
    total: 0,
    outcomes: [],
    run: vi.fn(),
    reset: vi.fn(),
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

// The menu item and the confirm dialog's button share a label, so menu
// lookups are scoped to the menu.
const menuItem = (label: string) =>
  within(screen.getByRole("menu")).getByText(label).closest("button")!
const confirmButton = (label: string) =>
  within(screen.getByRole("alertdialog")).getByText(label)

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

    fireEvent.click(menuItem("assignments.bulk.lock"))
    fireEvent.click(confirmButton("assignments.bulk.lock"))

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
  const lockButton = () => menuItem("assignments.bulk.lock")
  const unlockButton = () => menuItem("assignments.bulk.unlock")

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

// No bulk action clears the selection: Clear is one click away in the toolbar,
// and a bulk delete empties itself once assignments.json refetches.
describe("AssignmentsBulkBar selection lifetime", () => {
  const openReuse = () => fireEvent.click(menuItem("assignments.bulk.reuse"))

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

    fireEvent.click(menuItem("assignments.bulk.lock"))
    fireEvent.click(confirmButton("assignments.bulk.lock"))

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

    fireEvent.click(menuItem("assignments.bulk.delete"))
    // Delete acknowledges first, then wants the word typed.
    fireEvent.click(screen.getByText("components.confirmModal.yesContinue"))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "assignments.bulk.deleteConfirmWord" },
    })
    fireEvent.click(confirmButton("assignments.bulk.delete"))

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

    fireEvent.click(menuItem("assignments.bulk.lock"))
    fireEvent.click(confirmButton("assignments.bulk.lock"))

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

// One toast per outcome kind, so the teacher learns what actually happened.
describe("AssignmentsBulkBar outcome toasts", () => {
  const messages = () => notify.mock.calls.map((c) => c[0].message)
  const confirmDelete = () => {
    fireEvent.click(menuItem("assignments.bulk.delete"))
    fireEvent.click(screen.getByText("components.confirmModal.yesContinue"))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "assignments.bulk.deleteConfirmWord" },
    })
    fireEvent.click(confirmButton("assignments.bulk.delete"))
  }

  it("reports how many were locked", async () => {
    lockMutate.mockResolvedValue({
      changed: ["hw1", "hw2"],
      missing: [],
      outcomes: [{ slug: "hw1" }, { slug: "hw2" }],
      newCommitSha: "sha",
    })
    renderBar({ selected: ["hw1", "hw2"] })

    fireEvent.click(menuItem("assignments.bulk.lock"))
    fireEvent.click(confirmButton("assignments.bulk.lock"))

    await vi.waitFor(() => expect(lockMutate).toHaveBeenCalled())
    expect(messages()).toEqual(["assignments.bulk.lockDone:2"])
  })

  it("sends locked: false from Unlock and reports it as unlocked", async () => {
    lockMutate.mockResolvedValue({
      changed: ["hw3"],
      missing: [],
      outcomes: [{ slug: "hw3" }],
      newCommitSha: "sha",
    })
    renderBar({ selected: ["hw3"] })

    fireEvent.click(menuItem("assignments.bulk.unlock"))
    fireEvent.click(confirmButton("assignments.bulk.unlock"))

    await vi.waitFor(() => expect(lockMutate).toHaveBeenCalled())
    expect(lockMutate.mock.calls[0][0]).toEqual({
      slugs: ["hw3"],
      locked: false,
    })
    expect(messages()).toEqual(["assignments.bulk.unlockDone:1"])
  })

  it("says nothing changed when every selected row was already in state", async () => {
    lockMutate.mockResolvedValue({
      changed: [],
      missing: [],
      outcomes: [{ slug: "hw1" }],
      newCommitSha: null,
    })
    renderBar({ selected: ["hw1"] })

    fireEvent.click(menuItem("assignments.bulk.lock"))
    fireEvent.click(confirmButton("assignments.bulk.lock"))

    await vi.waitFor(() => expect(lockMutate).toHaveBeenCalled())
    expect(messages()).toEqual(["assignments.bulk.lockNoChange"])
  })

  it("names the slugs whose template access could not be updated", async () => {
    lockMutate.mockResolvedValue({
      changed: ["hw1", "hw2"],
      missing: [],
      outcomes: [
        { slug: "hw1", templateAccessWarning: "could not revoke" },
        { slug: "hw2" },
      ],
      newCommitSha: "sha",
    })
    renderBar({ selected: ["hw1", "hw2"] })

    fireEvent.click(menuItem("assignments.bulk.lock"))
    fireEvent.click(confirmButton("assignments.bulk.lock"))

    await vi.waitFor(() => expect(lockMutate).toHaveBeenCalled())
    const warning = notify.mock.calls
      .map((c) => c[0] as { message: string; tone?: string })
      .find((n) => n.message.startsWith("assignments.bulk.templateWarnings"))
    expect(warning?.tone).toBe("warning")
    expect(warning?.message).toBe("assignments.bulk.templateWarnings:1")
  })

  it("reports how many were deleted", async () => {
    renderBar({ selected: ["hw1"] })

    confirmDelete()

    await vi.waitFor(() => expect(deleteMutate).toHaveBeenCalled())
    expect(messages()).toEqual(["assignments.bulk.deleteDone:1"])
  })

  it("says nothing changed when a delete found nothing to remove", async () => {
    deleteMutate.mockResolvedValue({
      deleted: [],
      missing: [],
      newCommitSha: null,
    })
    renderBar({ selected: ["hw1"] })

    confirmDelete()

    await vi.waitFor(() => expect(deleteMutate).toHaveBeenCalled())
    expect(messages()).toEqual(["assignments.bulk.deleteNoChange"])
  })
})
