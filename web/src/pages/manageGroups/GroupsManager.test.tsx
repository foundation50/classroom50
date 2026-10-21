// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Pins the create-group name field's Enter handling (#1003): Enter creates the
// group, except for the Enter an IME uses to commit a candidate, which would
// otherwise create a group with a half-composed name. Also pins the page-level
// student/staff routing to the unassigned panel (#1123).

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "teacher" } }),
}))
vi.mock("@/hooks/useGroupTeams", () => ({
  default: () => ({ data: [], isLoading: false }),
}))
vi.mock("@/hooks/useGroupTeamMembers", () => ({
  default: () => ({
    membersBySlug: new Map(),
    logins: new Set(),
    isPending: false,
  }),
}))
vi.mock("@/hooks/useTeamsSnapshot", () => ({
  default: () => ({ data: undefined, isLoading: false }),
}))
// One student and one head TA, so the real picker helpers have a split to
// make; only the data hook is stubbed. Hoisted because vi.mock factories run
// when the module graph loads, before this file's own top-level statements.
const roster = vi.hoisted(() => {
  const rosterRow = (username: string, roles: string[]) => ({
    key: username,
    state: "enrolled",
    roles,
    username,
    github_id: "1",
    first_name: "",
    last_name: "",
    section: "",
    email: "",
    avatar_url: "",
  })
  return {
    enrolled: [rosterRow("alice", ["student"]), rosterRow("hta", ["hta"])],
    staffSplitKnown: true,
  }
})
vi.mock("@/hooks/useGroupRoster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useGroupRoster")>()),
  useGroupRoster: () => ({
    enrolled: roster.enrolled,
    rosterLogins: new Set(["alice", "hta"]),
    fullNameByLogin: new Map(),
    staffRolesByLogin: new Map([["hta", ["hta"]]]),
    staffSplitKnown: roster.staffSplitKnown,
    isLoading: false,
  }),
}))
vi.mock("@/hooks/useGetClassAssignments", () => ({
  default: () => ({ data: undefined }),
}))
vi.mock("@/hooks/useGetMyOrgRepos", () => ({
  default: () => ({ data: undefined }),
}))

const createTeam = vi.fn().mockResolvedValue({})
vi.mock("@/hooks/mutations/useCreateGroupTeam", () => ({
  default: () => ({ mutateAsync: createTeam, isPending: false }),
}))
vi.mock("@/hooks/mutations/useAddGroupTeamMember", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock("@/hooks/mutations/useSaveTeamsSnapshot", () => ({
  useSyncTeamsSnapshot: () => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  }),
}))

// Sibling surfaces with their own data needs; none is under test here.
vi.mock("./ManageGroupDialog", () => ({
  ManageGroupDialog: () => null,
  describeTeamWriteError: () => "error",
}))
vi.mock("./CopyGroupsModal", () => ({ CopyGroupsModal: () => null }))
const panelSpy = vi.hoisted(() => vi.fn<(props: unknown) => null>(() => null))
vi.mock("./UnassignedStudentsPanel", () => ({
  UnassignedStudentsPanel: panelSpy,
}))

import { GroupsManager } from "./GroupsManager"
import type { UnassignedStudentsPanel } from "./UnassignedStudentsPanel"

type PanelProps = Parameters<typeof UnassignedStudentsPanel>[0]
const lastPanelProps = (): PanelProps =>
  panelSpy.mock.calls.at(-1)?.[0] as PanelProps

// happy-dom lacks the native <dialog> showModal/close.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
    this.dispatchEvent(new Event("close"))
  }
})

afterEach(() => {
  cleanup()
  createTeam.mockClear()
  panelSpy.mockClear()
  roster.staffSplitKnown = true
})

const renderPage = () =>
  render(
    <GroupsManager
      org="acme"
      classroom="cs50"
      assignmentSlug="hw1"
      formation="teacher"
    />,
  )

// A head TA on the roster used to be listed as an unassigned student (#1123).
// The split lives in pure helpers; this pins the page actually using them.
describe("GroupsManager unassigned students", () => {
  it("hands the panel students only and counts the staff it left out", () => {
    renderPage()
    const props = lastPanelProps()
    expect(props.students.map((s) => s.username)).toEqual(["alice"])
    expect(props.unlistedStaffCount).toBe(1)
  })

  it("lists everyone when the roster can't tell staff from students", () => {
    roster.staffSplitKnown = false
    renderPage()
    const props = lastPanelProps()
    expect(props.students.map((s) => s.username)).toEqual(["alice", "hta"])
    expect(props.unlistedStaffCount).toBe(0)
  })
})

const openCreateDialog = async () => {
  renderPage()
  const user = userEvent.setup()
  // The dialog footer reuses the label; the page-level trigger comes first.
  await user.click(screen.getAllByText("manageGroups.createButton")[0])
  const input = screen.getByLabelText(
    "manageGroups.createNameLabel",
  ) as HTMLInputElement
  await user.type(input, "Team Rocket")
  return input
}

describe("GroupsManager create-group name field", () => {
  it("does not create the group on the Enter that commits an IME candidate", async () => {
    const input = await openCreateDialog()

    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })
    expect(createTeam).not.toHaveBeenCalled()
  })

  it("creates the group on a plain Enter", async () => {
    const input = await openCreateDialog()

    fireEvent.keyDown(input, { key: "Enter" })
    expect(createTeam).toHaveBeenCalledTimes(1)
    expect(createTeam.mock.calls[0][0]).toMatchObject({
      displayName: "Team Rocket",
      creatorLogin: "teacher",
    })
  })
})
