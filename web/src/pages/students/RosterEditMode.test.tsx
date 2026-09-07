// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"

// Direct tests for the batch Edit mode surface: staging metadata edits and
// links enables Save with a running count, Save composes ONE applyRosterEdits
// call, and Cancel with staged work routes through the discard confirm.

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

// ConfirmModal stub: visible only while open, with a confirm trigger, so the
// discard flow can be asserted and driven.
vi.mock("@/components/modals", () => ({
  ConfirmModal: (props: {
    open: boolean
    title: string
    onConfirm: () => Promise<void>
  }) =>
    props.open ? (
      <div data-testid="confirm-modal">
        <span>{props.title}</span>
        <button type="button" onClick={() => void props.onConfirm()}>
          confirm-discard
        </button>
      </div>
    ) : null,
}))

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

const applyRosterEdits = vi.fn()
vi.mock("@/domain/students", () => ({
  applyRosterEdits: (...args: unknown[]) => applyRosterEdits(...args),
  // Mirrors the real addressing rule closely enough to assert composed edits.
  unlinkedRowRef: (row: {
    email: string
    first_name: string
    last_name: string
    section: string
  }) =>
    row.email.trim()
      ? { email: row.email.trim().toLowerCase() }
      : {
          first_name: row.first_name.trim(),
          last_name: row.last_name.trim(),
          section: row.section.trim(),
        },
}))

import RosterEditMode from "./RosterEditMode"
import type { TeamRosterRow } from "@/util/teamRoster"

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

const enrolled = row({
  username: "ada",
  github_id: "1",
  first_name: "Ada",
  last_name: "L",
  section: "s1",
})
const unlinked = row({
  key: "unlinked:grace",
  state: "unlinked",
  first_name: "Grace",
  last_name: "Hopper",
  section: "s2",
})

const candidates = [
  { id: 42, login: "ghopper", classrooms: ["cs101"] },
  { id: 43, login: "other", classrooms: [] },
]

// The widened pool: the classroom candidates plus a direct org joiner.
const orgCandidates = [
  ...candidates,
  { id: 44, login: "lonewolf", classrooms: [] },
]

const renderMode = ({
  rows = [enrolled, unlinked],
  orgLinkCandidates,
  orgPoolStatus,
  onCancel = vi.fn(),
  onSaved = vi.fn(),
}: {
  rows?: TeamRosterRow[]
  orgLinkCandidates?: { id: number; login: string; classrooms: string[] }[]
  orgPoolStatus?: "ready" | "loading" | "unavailable"
  onCancel?: () => void
  onSaved?: (result: unknown) => void
} = {}) =>
  render(
    <RosterEditMode
      org="acme"
      classroom="cs101"
      rows={rows}
      linkCandidates={candidates}
      orgLinkCandidates={orgLinkCandidates}
      orgPoolStatus={orgPoolStatus}
      onCancel={onCancel}
      onSaved={onSaved}
    />,
  )

const saveButton = () =>
  screen.getByText("students.editRoster.save").closest("button")!

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("RosterEditMode", () => {
  it("stages a metadata change: count appears and Save enables", () => {
    renderMode()
    expect(saveButton().disabled).toBe(true)
    expect(screen.queryByText(/students\.editRoster\.stagedCount/)).toBeNull()

    const firstName = screen.getAllByLabelText(
      "students.editRoster.firstName",
    )[0] as HTMLInputElement
    fireEvent.change(firstName, { target: { value: "Adalene" } })

    expect(screen.getByText("students.editRoster.stagedCount:1")).not.toBeNull()
    expect(saveButton().disabled).toBe(false)

    // Reverting the field back to the row's value unstages it.
    fireEvent.change(firstName, { target: { value: "Ada" } })
    expect(screen.queryByText(/students\.editRoster\.stagedCount/)).toBeNull()
    expect(saveButton().disabled).toBe(true)
  })

  it("stages a link from the unlinked row's combobox", () => {
    renderMode()
    const picker = screen.getByLabelText("students.editRoster.linkLabel")
    fireEvent.focus(picker)
    fireEvent.change(picker, { target: { value: "ghop" } })

    const option = screen.getByRole("option", { name: "ghopper" })
    fireEvent.pointerDown(option)

    expect(screen.getByText("students.editRoster.stagedCount:1")).not.toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it("saves all staged edits in ONE applyRosterEdits call and reports back", async () => {
    const result = {
      applied: 2,
      missed: [],
      linkedLogins: ["ghopper"],
      teamAddFailedLogins: [],
    }
    applyRosterEdits.mockResolvedValue(result)
    const onSaved = vi.fn()
    renderMode({ onSaved })

    // Metadata on the enrolled row + a link on the unlinked row.
    fireEvent.change(
      screen.getAllByLabelText("students.editRoster.section")[0],
      { target: { value: "s9" } },
    )
    const picker = screen.getByLabelText("students.editRoster.linkLabel")
    fireEvent.focus(picker)
    fireEvent.pointerDown(screen.getByRole("option", { name: "ghopper" }))
    expect(screen.getByText("students.editRoster.stagedCount:2")).not.toBeNull()

    await act(async () => {
      fireEvent.click(saveButton())
    })

    expect(applyRosterEdits).toHaveBeenCalledTimes(1)
    expect(applyRosterEdits.mock.calls[0]?.[1]).toEqual({
      org: "acme",
      classroom: "cs101",
      edits: [
        {
          kind: "metadata",
          key: { github_id: "1", username: "ada" },
          patch: { first_name: "Ada", last_name: "L", section: "s9" },
        },
        {
          kind: "link",
          rowRef: { first_name: "Grace", last_name: "Hopper", section: "s2" },
          member: { id: 42, login: "ghopper" },
        },
      ],
    })
    expect(onSaved).toHaveBeenCalledWith(result)
  })

  it("fuses a link and metadata staged on the SAME row into ONE edit", async () => {
    applyRosterEdits.mockResolvedValue({
      applied: 1,
      missed: [],
      linkedLogins: ["ghopper"],
      teamAddFailedLogins: [],
    })
    renderMode()

    const picker = screen.getByLabelText("students.editRoster.linkLabel")
    fireEvent.focus(picker)
    fireEvent.pointerDown(screen.getByRole("option", { name: "ghopper" }))
    // The unlinked row's first-name input (second row in the table).
    fireEvent.change(
      screen.getAllByLabelText("students.editRoster.firstName")[1],
      { target: { value: "Gracie" } },
    )

    // One atomic unit, not a link plus a login-keyed metadata edit.
    expect(screen.getByText("students.editRoster.stagedCount:1")).not.toBeNull()

    await act(async () => {
      fireEvent.click(saveButton())
    })

    expect(applyRosterEdits.mock.calls[0]?.[1]).toEqual({
      org: "acme",
      classroom: "cs101",
      edits: [
        {
          kind: "link",
          rowRef: { first_name: "Grace", last_name: "Hopper", section: "s2" },
          member: { id: 42, login: "ghopper" },
          patch: { first_name: "Gracie", last_name: "Hopper", section: "s2" },
        },
      ],
    })
  })

  it("routes Cancel through the discard confirm only when edits are staged", () => {
    const onCancel = vi.fn()
    renderMode({ onCancel })

    // Nothing staged: plain exit, no confirm.
    fireEvent.click(screen.getByText("students.editRoster.cancel"))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("confirm-modal")).toBeNull()

    fireEvent.change(
      screen.getAllByLabelText("students.editRoster.firstName")[0],
      { target: { value: "Changed" } },
    )
    fireEvent.click(screen.getByText("students.editRoster.cancel"))
    expect(screen.getByTestId("confirm-modal")).not.toBeNull()
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText("confirm-discard"))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it("surfaces a failed save inline and stays in edit mode", async () => {
    applyRosterEdits.mockRejectedValue(new Error("boom"))
    const onSaved = vi.fn()
    renderMode({ onSaved })

    fireEvent.change(
      screen.getAllByLabelText("students.editRoster.firstName")[0],
      { target: { value: "Changed" } },
    )
    await act(async () => {
      fireEvent.click(saveButton())
    })

    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByText("students.editRoster.saveFailed")).not.toBeNull()
  })

  it("hides the org-wide toggle by default and when no row is unlinked", () => {
    renderMode()
    expect(
      screen.queryByText("students.editRoster.includeOrgMembers"),
    ).toBeNull()

    cleanup()
    renderMode({
      rows: [enrolled],
      orgLinkCandidates: orgCandidates,
      orgPoolStatus: "ready",
    })
    expect(
      screen.queryByText("students.editRoster.includeOrgMembers"),
    ).toBeNull()
  })

  it("the header toggle widens every picker to the org pool", () => {
    renderMode({ orgLinkCandidates: orgCandidates, orgPoolStatus: "ready" })

    const picker = screen.getByLabelText("students.editRoster.linkLabel")
    fireEvent.focus(picker)
    expect(screen.queryByRole("option", { name: /lonewolf/ })).toBeNull()

    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.focus(picker)
    expect(
      screen.getByRole("option", { name: /lonewolf/ }).textContent,
    ).toContain("students.editRoster.notInClassroom")
  })
})
