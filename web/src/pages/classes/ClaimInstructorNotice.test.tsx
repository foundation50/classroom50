// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactElement } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const orgRoleMock = vi.fn()
const classroomCtxMock = vi.fn()
const notifyMock = vi.fn()
const ensureTeamMock = vi.fn()
const grantWriteMock = vi.fn()
const addUserMock = vi.fn()

vi.mock("@/context/githubOrgRole/GitHubOrgRoleProvider", () => ({
  useGitHubOrgRole: () => orgRoleMock(),
}))
vi.mock("@/context/classroomRole/ClassroomRoleProvider", () => ({
  useClassroomRoleContext: () => classroomCtxMock(),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "owner1" } }),
}))
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify: notifyMock }),
}))
vi.mock("@/github-core/mutations", () => ({
  ensureClassroomRoleTeam: (...a: unknown[]) => ensureTeamMock(...a),
  grantTeamConfigRepoWrite: (...a: unknown[]) => grantWriteMock(...a),
  addUserToTeam: (...a: unknown[]) => addUserMock(...a),
}))

import { ClaimInstructorNotice } from "./ClaimInstructorNotice"

const wrap = (ui: ReactElement) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  orgRoleMock.mockReset()
  classroomCtxMock.mockReset()
  notifyMock.mockReset()
  ensureTeamMock.mockReset()
  grantWriteMock.mockReset()
  addUserMock.mockReset()
})

const action = "classes.claimInstructor.action"

describe("ClaimInstructorNotice visibility", () => {
  it("shows for an org owner resolving to student in the classroom", () => {
    orgRoleMock.mockReturnValue({ githubOrgRole: "owner" })
    classroomCtxMock.mockReturnValue({ actualRole: "student" })
    wrap(<ClaimInstructorNotice org="acme" classroom="cs101" />)
    expect(screen.queryByText(action)).toBeTruthy()
  })

  it("hidden for an owner who is already an instructor", () => {
    orgRoleMock.mockReturnValue({ githubOrgRole: "owner" })
    classroomCtxMock.mockReturnValue({ actualRole: "instructor" })
    wrap(<ClaimInstructorNotice org="acme" classroom="cs101" />)
    expect(screen.queryByText(action)).toBeNull()
  })

  it("hidden for a non-owner (plain student)", () => {
    orgRoleMock.mockReturnValue({ githubOrgRole: "member" })
    classroomCtxMock.mockReturnValue({ actualRole: "student" })
    wrap(<ClaimInstructorNotice org="acme" classroom="cs101" />)
    expect(screen.queryByText(action)).toBeNull()
  })

  it("hidden while the role is unresolved (fail-closed)", () => {
    orgRoleMock.mockReturnValue({ githubOrgRole: "unresolved" })
    classroomCtxMock.mockReturnValue({ actualRole: "unresolved" })
    wrap(<ClaimInstructorNotice org="acme" classroom="cs101" />)
    expect(screen.queryByText(action)).toBeNull()
  })
})

describe("ClaimInstructorNotice self-add", () => {
  it("ensures the team, grants write, and adds the viewer as maintainer", async () => {
    orgRoleMock.mockReturnValue({ githubOrgRole: "owner" })
    classroomCtxMock.mockReturnValue({ actualRole: "student" })
    ensureTeamMock.mockResolvedValue({ slug: "classroom50-cs101-instructor" })
    grantWriteMock.mockResolvedValue(undefined)
    addUserMock.mockResolvedValue(undefined)

    wrap(<ClaimInstructorNotice org="acme" classroom="cs101" />)
    await userEvent.click(screen.getByText(action))

    expect(ensureTeamMock).toHaveBeenCalledWith(
      {},
      "acme",
      "cs101",
      "instructor",
    )
    expect(addUserMock).toHaveBeenCalledWith(
      {},
      {
        org: "acme",
        teamSlug: "classroom50-cs101-instructor",
        username: "owner1",
        role: "maintainer",
      },
    )
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" }),
    )
  })

  it("surfaces an error toast when the add fails", async () => {
    orgRoleMock.mockReturnValue({ githubOrgRole: "owner" })
    classroomCtxMock.mockReturnValue({ actualRole: "student" })
    ensureTeamMock.mockResolvedValue({ slug: "classroom50-cs101-instructor" })
    grantWriteMock.mockResolvedValue(undefined)
    addUserMock.mockRejectedValue(new Error("boom"))

    wrap(<ClaimInstructorNotice org="acme" classroom="cs101" />)
    await userEvent.click(screen.getByText(action))

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error" }),
    )
  })
})
