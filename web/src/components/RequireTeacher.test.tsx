// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// Mock the three role signals the guard reads, plus the router param + the
// fallback/notfound leaves (which otherwise need a router).
const classroomCtxMock = vi.fn()
const orgRoleMock = vi.fn()
const configRepoMock = vi.fn()
const paramsMock = vi.fn()

vi.mock("@/context/classroomRole/ClassroomRoleProvider", () => ({
  useClassroomRoleContext: () => classroomCtxMock(),
}))
vi.mock("@/context/orgRole/OrgRoleProvider", () => ({
  useOrgRole: () => orgRoleMock(),
}))
vi.mock("@/hooks/useConfigRepoAccess", () => ({
  useConfigRepoAccess: () => configRepoMock(),
}))
vi.mock("@tanstack/react-router", () => ({
  useParams: () => paramsMock(),
}))
vi.mock("@/components/NotFound", () => ({
  default: () => <div data-testid="notfound" />,
}))
vi.mock("@/components/RoleResolvingFallback", () => ({
  default: () => <div data-testid="spinner" />,
}))
vi.mock("@/components/QueryErrorAlert", () => ({
  QueryErrorAlert: ({ onRetry }: { onRetry: () => void }) => (
    <button data-testid="error-retry" onClick={onRetry} />
  ),
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import RequireTeacher from "./RequireTeacher"

const child = <div data-testid="child" />

const shown = () => {
  if (screen.queryByTestId("child")) return "child"
  if (screen.queryByTestId("error-retry")) return "error"
  if (screen.queryByTestId("spinner")) return "spinner"
  if (screen.queryByTestId("notfound")) return "notfound"
  return "none"
}

// Default classroom context: an instructor (overridden per test).
const ctx = (over: Record<string, unknown> = {}) => ({
  role: "instructor",
  actualRole: "instructor",
  isLoading: false,
  isError: false,
  retry: () => {},
  isTeacher: true,
  isStudent: false,
  roleResolved: true,
  showTeacherUi: true,
  ...over,
})

afterEach(() => {
  cleanup()
  classroomCtxMock.mockReset()
  orgRoleMock.mockReset()
  configRepoMock.mockReset()
  paramsMock.mockReset()
})

describe("RequireTeacher — staff gate on a classroom", () => {
  it("a TA (staff) reaches classroom content", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "ta", actualRole: "ta" }))
    render(<RequireTeacher allow="staff">{child}</RequireTeacher>)
    expect(shown()).toBe("child")
  })

  it("a student is 404'd from staff content", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "student", actualRole: "student", showTeacherUi: false }),
    )
    render(<RequireTeacher allow="staff">{child}</RequireTeacher>)
    expect(shown()).toBe("notfound")
  })

  it("holds the spinner while unresolved, never flashes NotFound (R5)", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ roleResolved: false, showTeacherUi: false }),
    )
    render(<RequireTeacher allow="staff">{child}</RequireTeacher>)
    expect(shown()).toBe("spinner")
  })

  it("shows a retryable error when the role read settles in error", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({
        role: "unresolved",
        roleResolved: false,
        showTeacherUi: false,
        isError: true,
      }),
    )
    render(<RequireTeacher allow="staff">{child}</RequireTeacher>)
    expect(shown()).toBe("error")
  })
})

describe("RequireTeacher — instructor gate on a classroom", () => {
  it("an instructor reaches classroom settings", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "instructor" }))
    render(<RequireTeacher allow="instructor">{child}</RequireTeacher>)
    expect(shown()).toBe("child")
  })

  it("a TA is 404'd from instructor settings", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "ta" }))
    render(<RequireTeacher allow="instructor">{child}</RequireTeacher>)
    expect(shown()).toBe("notfound")
  })

  it("a non-instructor-team org owner is treated as student inside the classroom (KTD-4)", () => {
    // KTD-4: org-admin no longer implies classroom instructor. The classroom
    // context resolves them to `student`, so the instructor gate 404s.
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "student" }))
    render(<RequireTeacher allow="instructor">{child}</RequireTeacher>)
    expect(shown()).toBe("notfound")
  })

  it("holds the spinner while the classroom role is unresolved", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "unresolved", roleResolved: false }),
    )
    render(<RequireTeacher allow="instructor">{child}</RequireTeacher>)
    expect(shown()).toBe("spinner")
  })

  it("admits a confirmed instructor even while sibling reads are still loading (no spinner-over-wait)", () => {
    // roleResolved is true once the instructor read confirms; the gate must not
    // hold on isLoading waiting for the irrelevant ta/student reads.
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "instructor", roleResolved: true, isLoading: true }),
    )
    render(<RequireTeacher allow="instructor">{child}</RequireTeacher>)
    expect(shown()).toBe("child")
  })

  it("shows a retryable error (not an infinite spinner) when an elevation read settles in error", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "unresolved", roleResolved: false, isError: true }),
    )
    render(<RequireTeacher allow="instructor">{child}</RequireTeacher>)
    expect(shown()).toBe("error")
  })
})

describe("RequireTeacher — owner gate on org-level routes", () => {
  it("an org owner reaches org-wide settings", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgRoleMock.mockReturnValue({ orgRole: "owner" })
    render(<RequireTeacher allow="owner">{child}</RequireTeacher>)
    expect(shown()).toBe("child")
  })

  it("a non-instructor-team org owner is STILL an owner org-wide (KTD-4)", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgRoleMock.mockReturnValue({ orgRole: "owner" })
    render(<RequireTeacher allow="owner">{child}</RequireTeacher>)
    expect(shown()).toBe("child")
  })

  it("a member is 404'd from org-wide settings", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgRoleMock.mockReturnValue({ orgRole: "member" })
    render(<RequireTeacher allow="owner">{child}</RequireTeacher>)
    expect(shown()).toBe("notfound")
  })

  it("holds the spinner while org role is unresolved", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgRoleMock.mockReturnValue({ orgRole: "unresolved" })
    render(<RequireTeacher allow="owner">{child}</RequireTeacher>)
    expect(shown()).toBe("spinner")
  })

  it("shows a retryable error (not an infinite spinner) when the membership read settles in error", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgRoleMock.mockReturnValue({
      orgRole: "unresolved",
      isError: true,
      retry: () => {},
    })
    render(<RequireTeacher allow="owner">{child}</RequireTeacher>)
    expect(shown()).toBe("error")
  })
})

describe("RequireTeacher — staff gate on an org-level route (no classroom)", () => {
  it("uses the org config-repo verdict (Published page)", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    configRepoMock.mockReturnValue({ showTeacherUi: true, roleResolved: true })
    render(<RequireTeacher>{child}</RequireTeacher>)
    expect(shown()).toBe("child")
  })

  it("404s a non-staff org member", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    configRepoMock.mockReturnValue({ showTeacherUi: false, roleResolved: true })
    render(<RequireTeacher>{child}</RequireTeacher>)
    expect(shown()).toBe("notfound")
  })

  it("shows a retryable error when the config-repo read settles in error", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    configRepoMock.mockReturnValue({
      showTeacherUi: false,
      roleResolved: false,
      isError: true,
      refetch: () => {},
    })
    render(<RequireTeacher>{child}</RequireTeacher>)
    expect(shown()).toBe("error")
  })
})
