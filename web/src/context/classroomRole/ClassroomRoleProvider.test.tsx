// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// Drive the provider from a mocked useClassroomRole (the fine role) + auth user,
// so the test controls exactly what the boundary resolves. The provider exposes
// the fine role + roleResolved; permission verdicts are derived at call sites
// via can() (covered in capabilities.test.ts + StaffSidebarMenu.test.tsx).
const classroomRoleMock = vi.fn()

vi.mock("@/hooks/useClassroomRole", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useClassroomRole")>()
  return { ...actual, useClassroomRole: () => classroomRoleMock() }
})
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "prof" } }),
}))
// The provider mounts the best-effort teacher-team self-heal migration; it
// needs the GitHub client + query client and is orthogonal to role resolution,
// so stub it out here (its own behavior is covered in
// useTeacherTeamMigration.test.tsx).
vi.mock("@/hooks/useTeacherTeamMigration", () => ({
  useTeacherTeamMigration: () => {},
}))
// Same rationale: the provider also mounts the best-effort student-team
// description backfill; its own behavior is covered in
// useTeamDescriptionBackfill.test.tsx, so stub it here.
vi.mock("@/hooks/useTeamDescriptionBackfill", () => ({
  useTeamDescriptionBackfill: () => {},
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
  it("supplies role/actualRole to children", () => {
    classroomRoleMock.mockReturnValue({
      role: "teacher",
      actualRole: "teacher",
      isLoading: false,
    })
    renderProvider()
    expect(screen.getByTestId("role").textContent).toBe("teacher")
    expect(screen.getByTestId("actualRole").textContent).toBe("teacher")
    expect(screen.getByTestId("roleResolved").textContent).toBe("true")
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

  it("exposes the preview-clamped role and the real actualRole", () => {
    // useClassroomRole already returns the preview-clamped `role`; the provider
    // passes both through so call sites can gate UI on `role` and query-enables
    // on `actualRole`.
    classroomRoleMock.mockReturnValue({
      role: "student",
      actualRole: "teacher",
      isLoading: false,
    })
    renderProvider()
    expect(screen.getByTestId("role").textContent).toBe("student")
    expect(screen.getByTestId("actualRole").textContent).toBe("teacher")
    expect(screen.getByTestId("roleResolved").textContent).toBe("true")
  })

  it("holds unresolved as fail-closed (roleResolved false)", () => {
    classroomRoleMock.mockReturnValue({
      role: "unresolved",
      actualRole: "unresolved",
      isLoading: true,
    })
    renderProvider()
    expect(screen.getByTestId("role").textContent).toBe("unresolved")
    expect(screen.getByTestId("roleResolved").textContent).toBe("false")
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
