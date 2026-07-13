// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// Drive the provider from a mocked useClassroomRole (the fine role) + auth user,
// so the test controls exactly what the boundary resolves. The provider derives
// the coarse verdict purely from the fine role.
const classroomRoleMock = vi.fn()

vi.mock("@/hooks/useClassroomRole", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useClassroomRole")>()
  return { ...actual, useClassroomRole: () => classroomRoleMock() }
})
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "prof" } }),
}))

import {
  ClassroomRoleProvider,
  useClassroomRoleContext,
} from "./ClassroomRoleProvider"

const Probe = () => {
  const ctx = useClassroomRoleContext()
  return (
    <div>
      <span data-testid="role">{ctx.role}</span>
      <span data-testid="actualRole">{ctx.actualRole}</span>
      <span data-testid="isTeacher">{String(ctx.isTeacher)}</span>
      <span data-testid="showTeacherUi">{String(ctx.showTeacherUi)}</span>
      <span data-testid="isStudent">{String(ctx.isStudent)}</span>
      <span data-testid="roleResolved">{String(ctx.roleResolved)}</span>
      <span data-testid="isError">{String(ctx.isError)}</span>
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
})

describe("ClassroomRoleProvider", () => {
  it("supplies role/actualRole and the derived coarse verdict to children", () => {
    classroomRoleMock.mockReturnValue({
      role: "instructor",
      actualRole: "instructor",
      isLoading: false,
    })
    renderProvider()
    expect(screen.getByTestId("role").textContent).toBe("instructor")
    expect(screen.getByTestId("actualRole").textContent).toBe("instructor")
    expect(screen.getByTestId("isTeacher").textContent).toBe("true")
    expect(screen.getByTestId("showTeacherUi").textContent).toBe("true")
  })

  it("resolves the classroom role exactly once per mount (single useClassroomRole call)", () => {
    classroomRoleMock.mockReturnValue({
      role: "ta",
      actualRole: "ta",
      isLoading: false,
    })
    renderProvider()
    expect(classroomRoleMock).toHaveBeenCalledTimes(1)
  })

  it("a TA is staff (sees teacher content)", () => {
    classroomRoleMock.mockReturnValue({
      role: "ta",
      actualRole: "ta",
      isLoading: false,
    })
    renderProvider()
    expect(screen.getByTestId("isTeacher").textContent).toBe("true")
    expect(screen.getByTestId("showTeacherUi").textContent).toBe("true")
    expect(screen.getByTestId("isStudent").textContent).toBe("false")
  })

  // The coarse verdict is DERIVED from the fine role, so a student never gets
  // teacher UI regardless of any org-level config-repo access.
  it("a student gets NO teacher UI", () => {
    classroomRoleMock.mockReturnValue({
      role: "student",
      actualRole: "student",
      isLoading: false,
    })
    renderProvider()
    expect(screen.getByTestId("role").textContent).toBe("student")
    expect(screen.getByTestId("isTeacher").textContent).toBe("false")
    expect(screen.getByTestId("showTeacherUi").textContent).toBe("false")
    expect(screen.getByTestId("isStudent").textContent).toBe("true")
  })

  it("the viewAs clamp flows through the resolved role: a clamped student hides teacher UI", () => {
    // useClassroomRole already returns the preview-clamped `role`; the derived
    // verdict follows it, so a clamped student sees no teacher UI.
    classroomRoleMock.mockReturnValue({
      role: "student",
      actualRole: "instructor",
      isLoading: false,
    })
    renderProvider()
    expect(screen.getByTestId("role").textContent).toBe("student")
    expect(screen.getByTestId("actualRole").textContent).toBe("instructor")
    expect(screen.getByTestId("showTeacherUi").textContent).toBe("false")
    expect(screen.getByTestId("isStudent").textContent).toBe("true")
  })

  it("holds unresolved as fail-closed (no teacher UI, not resolved)", () => {
    classroomRoleMock.mockReturnValue({
      role: "unresolved",
      actualRole: "unresolved",
      isLoading: true,
    })
    renderProvider()
    expect(screen.getByTestId("roleResolved").textContent).toBe("false")
    expect(screen.getByTestId("isTeacher").textContent).toBe("false")
    expect(screen.getByTestId("isStudent").textContent).toBe("false")
  })

  it("passes the elevation-read error state through to the context", () => {
    classroomRoleMock.mockReturnValue({
      role: "unresolved",
      actualRole: "unresolved",
      isLoading: false,
      isError: true,
      refetch: () => {},
    })
    renderProvider()
    expect(screen.getByTestId("isError").textContent).toBe("true")
    expect(screen.getByTestId("roleResolved").textContent).toBe("false")
  })

  it("throws when used outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(
      /useClassroomRoleContext must be used within a ClassroomRoleProvider/,
    )
    spy.mockRestore()
  })
})
