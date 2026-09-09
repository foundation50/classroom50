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

// The re-invite goes through its mutation hook; stub it with a mutate that
// honours the call-site onSuccess/onError split the component relies on.
const reinviteMutate = vi.fn()
let reinviteOutcome: { ok: { status: string } } | { error: Error } | undefined
vi.mock("@/hooks/mutations/useReinviteUnlinkedRow", () => ({
  useReinviteUnlinkedRow: () => ({
    isPending: false,
    mutate: (
      vars: unknown,
      opts: {
        onSuccess?: (r: { status: string }) => void
        onError?: (e: Error) => void
      },
    ) => {
      reinviteMutate(vars)
      if (!reinviteOutcome) return
      if ("ok" in reinviteOutcome) opts.onSuccess?.(reinviteOutcome.ok)
      else opts.onError?.(reinviteOutcome.error)
    },
  }),
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

// An email row whose invitation is no longer pending: the re-invite target.
const emailRow: TeamRosterRow = {
  ...row,
  key: "unlinked:grace@uni.edu",
  email: "grace@uni.edu",
}

const candidates = [
  { id: 42, login: "ghopper", classrooms: ["cs101"] },
  { id: 43, login: "other", classrooms: [] },
]

// The widened pool: the classroom candidates plus a direct org joiner no
// classroom team has seen.
const orgCandidates = [
  ...candidates,
  { id: 44, login: "lonewolf", classrooms: [] },
]

const renderSection = ({
  rosterRow = row,
  onWorkingChange = vi.fn(),
  onChanged = vi.fn(),
  onClose = vi.fn(),
  onError = vi.fn(),
  orgLinkCandidates = [] as {
    id: number
    login: string
    classrooms: string[]
  }[],
  orgPoolStatus = "unavailable" as "ready" | "loading" | "unavailable",
} = {}) => {
  render(
    <UnlinkedRowSection
      org="acme"
      classroom="cs101"
      row={rosterRow}
      linkCandidates={candidates}
      orgLinkCandidates={orgLinkCandidates}
      orgPoolStatus={orgPoolStatus}
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

// The picker lives behind the toolbar's "Link account" disclosure.
const openLinkPanel = () => {
  fireEvent.click(screen.getByText("students.linkAccountAction"))
}

const pickGhopper = () => {
  const picker = screen.getByRole("combobox")
  fireEvent.focus(picker)
  fireEvent.pointerDown(screen.getByRole("option", { name: "ghopper" }))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  reinviteOutcome = undefined
})

describe("UnlinkedRowSection", () => {
  it("shows one toolbar, and reveals the link picker only on Link account", () => {
    renderSection({ rosterRow: emailRow })

    // Idle: the three intents, no picker, no confirm.
    expect(screen.getByText("students.reinvite")).not.toBeNull()
    expect(screen.getByText("students.linkAccountAction")).not.toBeNull()
    expect(screen.getByText("students.removeRowAction")).not.toBeNull()
    expect(screen.queryByRole("combobox")).toBeNull()

    openLinkPanel()

    // Link panel replaces the toolbar and takes focus.
    expect(screen.getByRole("combobox")).toBe(document.activeElement)
    expect(screen.queryByText("students.reinvite")).toBeNull()
    expect(screen.queryByText("students.linkAccountAction")).toBeNull()
    expect(screen.queryByText("students.removeRowAction")).toBeNull()

    // Cancel returns to the toolbar with the picker reset.
    fireEvent.click(screen.getByText("common.cancel"))
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(screen.getByText("students.reinvite")).not.toBeNull()
  })

  it("offers Re-invite only for a row that has an address", () => {
    renderSection()
    expect(screen.queryByText("students.reinvite")).toBeNull()
    expect(screen.getByText("students.linkIntro")).not.toBeNull()
    expect(screen.getByText("students.linkAccountAction")).not.toBeNull()

    cleanup()
    renderSection({ rosterRow: emailRow })
    expect(screen.getByText("students.reinvite")).not.toBeNull()
    expect(screen.getByText("students.unlinkedEmailIntro")).not.toBeNull()
  })

  it("re-invites the address with the row's role and closes once sent", async () => {
    reinviteOutcome = { ok: { status: "sent" } }
    const { onChanged, onClose, onError } = renderSection({
      rosterRow: emailRow,
    })

    await act(async () => {
      fireEvent.click(screen.getByText("students.reinvite"))
    })

    expect(reinviteMutate).toHaveBeenCalledWith({
      email: "grace@uni.edu",
      role: "student",
    })
    expect(onChanged).toHaveBeenCalledWith("unlinked:grace@uni.edu")
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("stays open with next-step copy when GitHub sent nothing", async () => {
    reinviteOutcome = { ok: { status: "already-invited-or-member" } }
    const { onChanged, onClose, onError } = renderSection({
      rosterRow: emailRow,
    })

    await act(async () => {
      fireEvent.click(screen.getByText("students.reinvite"))
    })

    expect(onError).toHaveBeenCalledWith(
      "unlinked:grace@uni.edu",
      "students.reinviteRowAlreadyInvited",
    )
    expect(onChanged).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("surfaces a thrown re-invite failure", async () => {
    reinviteOutcome = { error: new Error("boom") }
    const { onClose, onError } = renderSection({ rosterRow: emailRow })

    await act(async () => {
      fireEvent.click(screen.getByText("students.reinvite"))
    })

    expect(onError).toHaveBeenCalledWith(
      "unlinked:grace@uni.edu",
      "students.reinviteRowFailed",
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it("links the picked member, filtering candidates by classroom too", async () => {
    linkRosterRowToMember.mockResolvedValue({ teamAdd: "ok" })
    const { onWorkingChange, onChanged, onClose, onError } = renderSection()

    openLinkPanel()
    expect(linkButton().disabled).toBe(true)

    // A classroom-name query narrows the list (the shared picker recipe
    // matches login OR classroom).
    const picker = screen.getByRole("combobox")
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

    openLinkPanel()
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

    // The toolbar trigger is replaced by the confirm block, so the remaining
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

  it("hides the org-wide toggle when the member list is unavailable", () => {
    renderSection({ orgPoolStatus: "unavailable" })
    openLinkPanel()
    expect(screen.queryByText("students.linkIncludeOrgMembers")).toBeNull()
  })

  it("offers org-only members only after the toggle is checked", () => {
    renderSection({ orgLinkCandidates: orgCandidates, orgPoolStatus: "ready" })
    openLinkPanel()

    const picker = screen.getByRole("combobox")
    fireEvent.focus(picker)
    expect(screen.queryByRole("option", { name: "lonewolf" })).toBeNull()

    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.focus(picker)
    expect(
      screen.getByRole("option", { name: /lonewolf/ }).textContent,
    ).toContain("students.linkNotInClassroom")
  })

  it("unchecking the toggle drops a staged org-only pick", () => {
    renderSection({ orgLinkCandidates: orgCandidates, orgPoolStatus: "ready" })
    openLinkPanel()

    const toggle = screen.getByRole("checkbox")
    fireEvent.click(toggle)
    const picker = screen.getByRole("combobox")
    fireEvent.focus(picker)
    fireEvent.pointerDown(screen.getByRole("option", { name: /lonewolf/ }))
    expect(linkButton().disabled).toBe(false)

    fireEvent.click(toggle)
    expect(linkButton().disabled).toBe(true)
  })
})
