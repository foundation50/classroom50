// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Pins the create-group name field's Enter handling (#1003): Enter creates the
// group, except for the Enter an IME uses to commit a candidate, which would
// otherwise create a group with a half-composed name.

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
vi.mock("@/hooks/useGroupRoster", () => ({
  useGroupRoster: () => ({
    enrolled: [],
    rosterLogins: new Set(),
    fullNameByLogin: new Map(),
    isLoading: false,
  }),
  toGroupPickerStudents: () => [],
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
vi.mock("./UnassignedStudentsPanel", () => ({
  UnassignedStudentsPanel: () => null,
}))

import { GroupsManager } from "./GroupsManager"

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
})

const openCreateDialog = async () => {
  render(
    <GroupsManager
      org="acme"
      classroom="cs50"
      assignmentSlug="hw1"
      formation="teacher"
    />,
  )
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
