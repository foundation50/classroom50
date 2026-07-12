// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { GitHubAPIError } from "@/hooks/github/errors"

// Drive the provider from fixtures: the classroom role, the config-repo read,
// the auth user, and the "view as" preview are all mocked so the test controls
// exactly what the boundary resolves.
const classroomRoleMock = vi.fn()
const repoQueryMock = vi.fn()
const viewAsMock = vi.fn()

vi.mock("@/hooks/useClassroomRole", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useClassroomRole")>()
  return { ...actual, useClassroomRole: () => classroomRoleMock() }
})
vi.mock("@/hooks/github/hooks", () => ({
  useGitHubRepo: () => repoQueryMock(),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "prof" } }),
}))
vi.mock("@/context/roleView/RoleViewProvider", () => ({
  useRoleView: () => ({ viewAs: viewAsMock(), setViewAs: () => {} }),
}))

import {
  ClassroomRoleProvider,
  useClassroomRoleContext,
} from "./ClassroomRoleProvider"

const teacherRepo = {
  isSuccess: true,
  data: { permissions: { push: true } },
  error: null,
}
const studentRepo = {
  isSuccess: false,
  data: undefined,
  error: new GitHubAPIError({
    status: 404,
    url: "x",
    message: "nf",
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  }),
}

const Probe = () => {
  const ctx = useClassroomRoleContext()
  return (
    <div>
      <span data-testid="role">{ctx.role}</span>
      <span data-testid="actualRole">{ctx.actualRole}</span>
      <span data-testid="showTeacherUi">{String(ctx.showTeacherUi)}</span>
      <span data-testid="isStudent">{String(ctx.isStudent)}</span>
    </div>
  )
}

const renderProvider = () =>
  render(
    <ClassroomRoleProvider org="acme" classroom="cs101">
      <Probe />
    </ClassroomRoleProvider>,
  )

afterEach(() => {
  cleanup()
  classroomRoleMock.mockReset()
  repoQueryMock.mockReset()
  viewAsMock.mockReset()
})

describe("ClassroomRoleProvider", () => {
  it("supplies role/actualRole and the coarse verdict to children", () => {
    classroomRoleMock.mockReturnValue({
      role: "instructor",
      actualRole: "instructor",
      isLoading: false,
    })
    repoQueryMock.mockReturnValue(teacherRepo)
    viewAsMock.mockReturnValue(null)
    renderProvider()
    expect(screen.getByTestId("role").textContent).toBe("instructor")
    expect(screen.getByTestId("actualRole").textContent).toBe("instructor")
    expect(screen.getByTestId("showTeacherUi").textContent).toBe("true")
  })

  it("resolves the classroom role exactly once per mount (single useClassroomRole call)", () => {
    classroomRoleMock.mockReturnValue({
      role: "ta",
      actualRole: "ta",
      isLoading: false,
    })
    repoQueryMock.mockReturnValue(teacherRepo)
    viewAsMock.mockReturnValue(null)
    renderProvider()
    // The child reads from context, so the boundary is the only resolver.
    expect(classroomRoleMock).toHaveBeenCalledTimes(1)
  })

  it("applies the downgrade-only viewAs clamp: viewAs=student hides teacher UI", () => {
    // useClassroomRole already returns the preview-clamped `role`; the provider
    // additionally clamps the coarse verdict.
    classroomRoleMock.mockReturnValue({
      role: "student",
      actualRole: "instructor",
      isLoading: false,
    })
    repoQueryMock.mockReturnValue(teacherRepo)
    viewAsMock.mockReturnValue("student")
    renderProvider()
    expect(screen.getByTestId("role").textContent).toBe("student")
    expect(screen.getByTestId("actualRole").textContent).toBe("instructor")
    expect(screen.getByTestId("showTeacherUi").textContent).toBe("false")
    expect(screen.getByTestId("isStudent").textContent).toBe("true")
  })

  it("a real student stays a student (coarse verdict 404)", () => {
    classroomRoleMock.mockReturnValue({
      role: "student",
      actualRole: "student",
      isLoading: false,
    })
    repoQueryMock.mockReturnValue(studentRepo)
    viewAsMock.mockReturnValue(null)
    renderProvider()
    expect(screen.getByTestId("showTeacherUi").textContent).toBe("false")
    expect(screen.getByTestId("isStudent").textContent).toBe("true")
  })

  it("throws when used outside a provider", () => {
    // Silence the expected React error boundary console noise.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(
      /useClassroomRoleContext must be used within a ClassroomRoleProvider/,
    )
    spy.mockRestore()
  })
})
