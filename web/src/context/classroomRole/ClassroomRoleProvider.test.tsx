// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { GitHubAPIError } from "@/hooks/github/errors"

// Drive the provider from fixtures: the resolved classroom role, the config-repo
// read (only `isBlocked` still comes from it), and the auth user are mocked so
// the test controls exactly what the boundary resolves.
const classroomRoleMock = vi.fn()
const repoQueryMock = vi.fn()

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

import {
  ClassroomRoleProvider,
  useClassroomRoleContext,
} from "./ClassroomRoleProvider"

// A readable config repo (an org owner can read it even for a classroom they
// don't instruct) — the exact condition that used to leak teacher UI.
const readableRepo = {
  isSuccess: true,
  data: { permissions: { push: true } },
  error: null,
}
const forbiddenRepo = {
  isSuccess: false,
  data: undefined,
  error: new GitHubAPIError({
    status: 403,
    url: "x",
    message: "forbidden",
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
      <span data-testid="isTeacher">{String(ctx.isTeacher)}</span>
      <span data-testid="showTeacherUi">{String(ctx.showTeacherUi)}</span>
      <span data-testid="isStudent">{String(ctx.isStudent)}</span>
      <span data-testid="roleResolved">{String(ctx.roleResolved)}</span>
      <span data-testid="isBlocked">{String(ctx.isBlocked)}</span>
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
})

describe("ClassroomRoleProvider", () => {
  it("supplies role/actualRole and the derived coarse verdict to children", () => {
    classroomRoleMock.mockReturnValue({
      role: "instructor",
      actualRole: "instructor",
      isLoading: false,
    })
    repoQueryMock.mockReturnValue(readableRepo)
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
    repoQueryMock.mockReturnValue(readableRepo)
    renderProvider()
    expect(classroomRoleMock).toHaveBeenCalledTimes(1)
  })

  it("a TA is staff (sees teacher content)", () => {
    classroomRoleMock.mockReturnValue({
      role: "ta",
      actualRole: "ta",
      isLoading: false,
    })
    repoQueryMock.mockReturnValue(readableRepo)
    renderProvider()
    expect(screen.getByTestId("isTeacher").textContent).toBe("true")
    expect(screen.getByTestId("showTeacherUi").textContent).toBe("true")
    expect(screen.getByTestId("isStudent").textContent).toBe("false")
  })

  // KTD-3 regression guard: the coarse verdict is DERIVED from the fine role,
  // NOT from config-repo access. An org owner who resolves to `student` in a
  // classroom they don't instruct can still READ the config repo (readableRepo),
  // but must NOT be granted teacher UI — the exact leak this provider fixed.
  it("an owner-as-student (config repo readable) gets NO teacher UI", () => {
    classroomRoleMock.mockReturnValue({
      role: "student",
      actualRole: "student",
      isLoading: false,
    })
    repoQueryMock.mockReturnValue(readableRepo)
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
    repoQueryMock.mockReturnValue(readableRepo)
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
    repoQueryMock.mockReturnValue(readableRepo)
    renderProvider()
    expect(screen.getByTestId("roleResolved").textContent).toBe("false")
    expect(screen.getByTestId("isTeacher").textContent).toBe("false")
    expect(screen.getByTestId("isStudent").textContent).toBe("false")
  })

  it("carries isBlocked from the config-repo verdict (403)", () => {
    classroomRoleMock.mockReturnValue({
      role: "student",
      actualRole: "student",
      isLoading: false,
    })
    repoQueryMock.mockReturnValue(forbiddenRepo)
    renderProvider()
    expect(screen.getByTestId("isBlocked").textContent).toBe("true")
  })

  it("throws when used outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(
      /useClassroomRoleContext must be used within a ClassroomRoleProvider/,
    )
    spy.mockRestore()
  })
})
