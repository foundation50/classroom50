// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"

// Direct tests for the modal's extracted unlinked-row section: the shared
// picker recipe filters by login OR classroom, linking/removing hand the
// result back through onChanged/onClose, typed domain errors map to
// teacher-actionable copy, and in-flight work is mirrored up.

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

const linkRosterRowToMember = vi.fn()
const removeUnlinkedRows = vi.fn()
vi.mock("@/domain/students", () => ({
  linkRosterRowToMember: (...args: unknown[]) => linkRosterRowToMember(...args),
  removeUnlinkedRows: (...args: unknown[]) => removeUnlinkedRows(...args),
  // Mirrors the real addressing rule closely enough to assert composed refs.
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
  UnlinkedRowNotFoundError: class extends Error {},
  UnlinkedRowAmbiguousError: class extends Error {},
  MemberNotActiveError: class extends Error {
    login: string
    constructor(login: string) {
      super(login)
      this.login = login
    }
  },
  MemberAlreadyOnRosterError: class extends Error {
    login: string
    constructor(login: string) {
      super(login)
      this.login = login
    }
  },
}))

import UnlinkedRowSection from "./UnlinkedRowSection"
import { MemberAlreadyOnRosterError } from "@/domain/students"
import type { TeamRosterRow } from "@/util/teamRoster"

const row: TeamRosterRow = {
  key: "unlinked:grace",
  state: "unlinked",
  roles: ["student"],
  username: "",
  github_id: "",
  first_name: "Grace",
  last_name: "Hopper",
  section: "s2",
  email: "",
  avatar_url: "",
}

const candidates = [
  { id: 42, login: "ghopper", classrooms: ["cs101"] },
  { id: 43, login: "other", classrooms: [] },
]

const renderSection = ({
  onWorkingChange = vi.fn(),
  onChanged = vi.fn(),
  onClose = vi.fn(),
  onError = vi.fn(),
} = {}) => {
  render(
    <UnlinkedRowSection
      org="acme"
      classroom="cs101"
      row={row}
      linkCandidates={candidates}
      busy={false}
      onWorkingChange={onWorkingChange}
      onChanged={onChanged}
      onClose={onClose}
      onError={onError}
    />,
  )
  return { onWorkingChange, onChanged, onClose, onError }
}

const linkButton = () =>
  screen.getByText("students.linkMemberAction").closest("button")!

const pickGhopper = () => {
  const picker = screen.getByLabelText("students.linkMemberLabel")
  fireEvent.focus(picker)
  fireEvent.pointerDown(screen.getByRole("option", { name: "ghopper" }))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("UnlinkedRowSection", () => {
  it("links the picked member, filtering candidates by classroom too", async () => {
    linkRosterRowToMember.mockResolvedValue({ teamAdd: "ok" })
    const { onWorkingChange, onChanged, onClose, onError } = renderSection()

    expect(linkButton().disabled).toBe(true)

    // A classroom-name query narrows the list (the shared picker recipe
    // matches login OR classroom).
    const picker = screen.getByLabelText("students.linkMemberLabel")
    fireEvent.focus(picker)
    fireEvent.change(picker, { target: { value: "cs101" } })
    expect(screen.queryByRole("option", { name: "other" })).toBeNull()
    fireEvent.pointerDown(screen.getByRole("option", { name: "ghopper" }))
    expect(linkButton().disabled).toBe(false)

    await act(async () => {
      fireEvent.click(linkButton())
    })

    expect(linkRosterRowToMember).toHaveBeenCalledTimes(1)
    expect(linkRosterRowToMember.mock.calls[0]?.[1]).toEqual({
      org: "acme",
      classroom: "cs101",
      rowRef: { first_name: "Grace", last_name: "Hopper", section: "s2" },
      member: { id: 42, login: "ghopper" },
    })
    expect(onChanged).toHaveBeenCalledWith("unlinked:grace")
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    // In-flight work was mirrored up, and released after the write settled.
    expect(onWorkingChange).toHaveBeenCalledWith(true)
    expect(onWorkingChange.mock.lastCall).toEqual([false])
  })

  it("maps a typed link failure to actionable copy and stays open", async () => {
    linkRosterRowToMember.mockRejectedValue(
      new MemberAlreadyOnRosterError("ghopper"),
    )
    const { onChanged, onClose, onError } = renderSection()

    pickGhopper()
    await act(async () => {
      fireEvent.click(linkButton())
    })

    expect(onError).toHaveBeenCalledWith(
      "unlinked:grace",
      "students.linkMemberClaimed",
    )
    expect(onChanged).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("removes the row only through the confirm step", async () => {
    removeUnlinkedRows.mockResolvedValue({ removed: 1 })
    const { onChanged, onClose } = renderSection()

    fireEvent.click(screen.getByText("students.removeRowAction"))
    expect(removeUnlinkedRows).not.toHaveBeenCalled()
    expect(screen.getByText("students.confirmRemoveRowBody")).not.toBeNull()

    // The ghost trigger is replaced by the confirm block, so the remaining
    // removeRowAction button is the destructive confirm.
    await act(async () => {
      fireEvent.click(screen.getByText("students.removeRowAction"))
    })

    expect(removeUnlinkedRows).toHaveBeenCalledTimes(1)
    expect(removeUnlinkedRows.mock.calls[0]?.[1]).toEqual({
      org: "acme",
      classroom: "cs101",
      rowRefs: [{ first_name: "Grace", last_name: "Hopper", section: "s2" }],
    })
    expect(onChanged).toHaveBeenCalledWith("unlinked:grace")
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
