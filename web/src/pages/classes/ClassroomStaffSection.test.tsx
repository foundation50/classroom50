// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

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
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>()
  return { ...actual, useQuery: () => ({ data: [], isLoading: false }) }
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

afterEach(() => {
  cleanup()
  roleMock.mockReset()
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
