// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import type { GitHubUser } from "@/github-core/types"

// Drive the defense-in-depth gate directly off the classroom role: a non-teacher
// must force the staff actions read-only even when the archived `disabled` prop
// is false. Real `can()` is used; only the role signal + leaf data hooks are mocked.
const roleMock = vi.fn()
vi.mock("@/context/classroomRole/ClassroomRoleProvider", () => ({
  useClassroomRoleContext: () => roleMock(),
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify: vi.fn() }),
}))

// Per-query-key data so a test can seed team members (to render StaffMemberRow)
// independently of the viewer read. Keyed by the second element of the query key
// (githubKeys.* shape: ["github", <kind>, ...]) — team-members vs viewer etc.
const membersByRole = new Map<string, GitHubUser[]>()
let viewerData: Partial<GitHubUser> | null = null
const resetQueryData = () => {
  membersByRole.clear()
  viewerData = null
}
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>()
  return {
    ...actual,
    useQuery: (options: { queryKey: readonly unknown[] }) => {
      const [, kind, , teamSlug] = options.queryKey as [
        string,
        string,
        string,
        string,
      ]
      if (kind === "viewer") return { data: viewerData, isLoading: false }
      if (kind === "team-members")
        return { data: membersByRole.get(teamSlug) ?? [], isLoading: false }
      // team-invitations and anything else: empty.
      return { data: [], isLoading: false }
    },
  }
})
const noopMutation = { mutate: vi.fn(), isPending: false }
vi.mock("@/hooks/mutations/useAddStaffMember", () => ({
  useAddStaffMember: () => noopMutation,
}))
vi.mock("@/hooks/mutations/useRemoveStaffMember", () => ({
  default: () => noopMutation,
}))
vi.mock("@/hooks/mutations/useResendStaffInvite", () => ({
  default: () => noopMutation,
}))
vi.mock("@/hooks/mutations/useCancelStaffInvite", () => ({
  default: () => noopMutation,
}))

import ClassroomStaffSection from "./ClassroomStaffSection"

const usernameInput = () =>
  screen.getByPlaceholderText(
    "classes.staff.usernamePlaceholder",
  ) as HTMLInputElement

// Minimal GitHubUser stub for a rendered staff member row.
const member = (login: string, id: number): GitHubUser =>
  ({
    login,
    id,
    avatar_url: "",
    html_url: `https://github.com/${login}`,
    name: null,
    email: null,
    bio: null,
    permissions: { admin: false, pull: true, maintain: false, push: false },
  }) as GitHubUser

beforeEach(() => {
  resetQueryData()
})

afterEach(() => {
  cleanup()
  roleMock.mockReset()
  resetQueryData()
})

describe("ClassroomStaffSection — canManageStaff gate", () => {
  it("a teacher can manage staff (actions enabled)", () => {
    roleMock.mockReturnValue({ role: "teacher" })
    render(<ClassroomStaffSection org="acme" classroom="cs101" />)
    expect(usernameInput().disabled).toBe(false)
  })

  it("a TA cannot manage staff even when not archived (actions disabled)", () => {
    roleMock.mockReturnValue({ role: "ta" })
    render(<ClassroomStaffSection org="acme" classroom="cs101" />)
    expect(usernameInput().disabled).toBe(true)
  })

  it("an archived classroom disables actions even for a teacher", () => {
    roleMock.mockReturnValue({ role: "teacher" })
    render(<ClassroomStaffSection org="acme" classroom="cs101" disabled />)
    expect(usernameInput().disabled).toBe(true)
  })
})

describe("ClassroomStaffSection — teacher self-removal from the teacher team", () => {
  const teacherSlug = "classroom50-cs101-teacher"
  const taSlug = "classroom50-cs101-ta"

  it("hides the Remove button on the viewer's own teacher row, showing a 'You' note", () => {
    roleMock.mockReturnValue({ role: "teacher" })
    viewerData = { id: 1, login: "tina" }
    membersByRole.set(teacherSlug, [member("tina", 1)])

    render(<ClassroomStaffSection org="acme" classroom="cs101" />)

    // The self-teacher row shows the "You" note (t() returns the key here)...
    expect(screen.getByText("classes.staff.you")).toBeTruthy()
    // ...and no Remove action is offered (its title is the removeRole key).
    expect(screen.queryByTitle("classes.staff.removeRole")).toBeNull()
  })

  it("shows the Remove button for a DIFFERENT teacher", () => {
    roleMock.mockReturnValue({ role: "teacher" })
    viewerData = { id: 1, login: "tina" }
    membersByRole.set(teacherSlug, [member("otherteacher", 2)])

    render(<ClassroomStaffSection org="acme" classroom="cs101" />)

    expect(screen.queryByText("classes.staff.you")).toBeNull()
    expect(screen.getByTitle("classes.staff.removeRole")).toBeTruthy()
  })

  it("shows the Remove button for the viewer's own row on a NON-teacher team", () => {
    // Self on the TA team is removable — the guard is teacher-only.
    roleMock.mockReturnValue({ role: "teacher" })
    viewerData = { id: 1, login: "tina" }
    membersByRole.set(taSlug, [member("tina", 1)])

    render(<ClassroomStaffSection org="acme" classroom="cs101" />)

    expect(screen.queryByText("classes.staff.you")).toBeNull()
    expect(screen.getByTitle("classes.staff.removeRole")).toBeTruthy()
  })
})
