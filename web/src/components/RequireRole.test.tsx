// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// Mock the three role signals the guard reads, plus the router param + the
// fallback/notfound leaves (which otherwise need a router).
const classroomCtxMock = vi.fn()
const orgRoleMock = vi.fn()
const orgStaffMock = vi.fn()
const paramsMock = vi.fn()

vi.mock("@/context/classroomRole/ClassroomRoleProvider", () => ({
  useClassroomRoleContext: () => classroomCtxMock(),
}))
vi.mock("@/context/githubOrgRole/GitHubOrgRoleProvider", () => ({
  useGitHubOrgRole: () => orgRoleMock(),
}))
vi.mock("@/hooks/useOrgStaff", () => ({
  useOrgStaff: () => orgStaffMock(),
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

import RequireRole from "./RequireRole"

const child = <div data-testid="child" />

const shown = () => {
  if (screen.queryByTestId("child")) return "child"
  if (screen.queryByTestId("error-retry")) return "error"
  if (screen.queryByTestId("spinner")) return "spinner"
  if (screen.queryByTestId("notfound")) return "notfound"
  return "none"
}

// Default classroom context: an teacher (overridden per test).
const ctx = (over: Record<string, unknown> = {}) => ({
  role: "teacher",
  actualRole: "teacher",
  isLoading: false,
  isError: false,
  retry: () => {},
  roleResolved: true,
  ...over,
})

afterEach(() => {
  cleanup()
  classroomCtxMock.mockReset()
  orgRoleMock.mockReset()
  orgStaffMock.mockReset()
  paramsMock.mockReset()
})

describe("RequireRole — staff gate on a classroom", () => {
  it("a TA (staff) reaches classroom content", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "ta", actualRole: "ta" }))
    render(<RequireRole allow="staff">{child}</RequireRole>)
    expect(shown()).toBe("child")
  })

  it("a student is 404'd from staff content", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "student", actualRole: "student" }),
    )
    render(<RequireRole allow="staff">{child}</RequireRole>)
    expect(shown()).toBe("notfound")
  })

  it("holds the spinner while unresolved, never flashes NotFound (R5)", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "unresolved", roleResolved: false }),
    )
    render(<RequireRole allow="staff">{child}</RequireRole>)
    expect(shown()).toBe("spinner")
  })

  it("shows a retryable error when the role read settles in error", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({
        role: "unresolved",
        roleResolved: false,
        isError: true,
      }),
    )
    render(<RequireRole allow="staff">{child}</RequireRole>)
    expect(shown()).toBe("error")
  })
})

describe("RequireRole — teacher gate on a classroom", () => {
  it("an teacher reaches classroom settings", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "teacher" }))
    render(<RequireRole allow="teacher">{child}</RequireRole>)
    expect(shown()).toBe("child")
  })

  it("a TA is 404'd from teacher settings", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "ta" }))
    render(<RequireRole allow="teacher">{child}</RequireRole>)
    expect(shown()).toBe("notfound")
  })

  it("a non-teacher-team org owner is treated as student inside the classroom (KTD-4)", () => {
    // KTD-4: org-admin no longer implies classroom teacher. The classroom
    // context resolves them to `student`, so the teacher gate 404s.
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "student" }))
    render(<RequireRole allow="teacher">{child}</RequireRole>)
    expect(shown()).toBe("notfound")
  })

  it("holds the spinner while the classroom role is unresolved", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "unresolved", roleResolved: false }),
    )
    render(<RequireRole allow="teacher">{child}</RequireRole>)
    expect(shown()).toBe("spinner")
  })

  it("admits a confirmed teacher even while sibling reads are still loading (no spinner-over-wait)", () => {
    // roleResolved is true once the teacher read confirms; the gate must not
    // hold on isLoading waiting for the irrelevant ta/student reads.
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "teacher", roleResolved: true, isLoading: true }),
    )
    render(<RequireRole allow="teacher">{child}</RequireRole>)
    expect(shown()).toBe("child")
  })

  it("shows a retryable error (not an infinite spinner) when an elevation read settles in error", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "unresolved", roleResolved: false, isError: true }),
    )
    render(<RequireRole allow="teacher">{child}</RequireRole>)
    expect(shown()).toBe("error")
  })
})

describe("RequireRole — author gate on a classroom", () => {
  it("a teacher can author", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "teacher" }))
    render(<RequireRole allow="author">{child}</RequireRole>)
    expect(shown()).toBe("child")
  })

  it("a head TA can author", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "hta" }))
    render(<RequireRole allow="author">{child}</RequireRole>)
    expect(shown()).toBe("child")
  })

  it("a plain TA is 404'd from authoring (read-only tier)", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "ta" }))
    render(<RequireRole allow="author">{child}</RequireRole>)
    expect(shown()).toBe("notfound")
  })

  it("a student is 404'd from authoring", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(ctx({ role: "student" }))
    render(<RequireRole allow="author">{child}</RequireRole>)
    expect(shown()).toBe("notfound")
  })

  it("holds the spinner while the classroom role is unresolved", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "unresolved", roleResolved: false }),
    )
    render(<RequireRole allow="author">{child}</RequireRole>)
    expect(shown()).toBe("spinner")
  })

  it("shows a retryable error when the role read settles in error", () => {
    paramsMock.mockReturnValue({ org: "acme", classroom: "cs101" })
    classroomCtxMock.mockReturnValue(
      ctx({ role: "unresolved", roleResolved: false, isError: true }),
    )
    render(<RequireRole allow="author">{child}</RequireRole>)
    expect(shown()).toBe("error")
  })
})

describe("RequireRole — owner gate on org-level routes", () => {
  it("an org owner reaches org-wide settings", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgRoleMock.mockReturnValue({ githubOrgRole: "owner" })
    render(<RequireRole allow="owner">{child}</RequireRole>)
    expect(shown()).toBe("child")
  })

  it("a non-teacher-team org owner is STILL an owner org-wide (KTD-4)", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgRoleMock.mockReturnValue({ githubOrgRole: "owner" })
    render(<RequireRole allow="owner">{child}</RequireRole>)
    expect(shown()).toBe("child")
  })

  it("a member is 404'd from org-wide settings", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgRoleMock.mockReturnValue({ githubOrgRole: "member" })
    render(<RequireRole allow="owner">{child}</RequireRole>)
    expect(shown()).toBe("notfound")
  })

  it("holds the spinner while org role is unresolved", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgRoleMock.mockReturnValue({ githubOrgRole: "unresolved" })
    render(<RequireRole allow="owner">{child}</RequireRole>)
    expect(shown()).toBe("spinner")
  })

  it("shows a retryable error (not an infinite spinner) when the membership read settles in error", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgRoleMock.mockReturnValue({
      githubOrgRole: "unresolved",
      isError: true,
      retry: () => {},
    })
    render(<RequireRole allow="owner">{child}</RequireRole>)
    expect(shown()).toBe("error")
  })
})

describe("RequireRole — staff gate on an org-level route (no classroom)", () => {
  it("uses the org team-based staff signal (Published page)", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgStaffMock.mockReturnValue({ isStaff: true, roleResolved: true })
    render(<RequireRole>{child}</RequireRole>)
    expect(shown()).toBe("child")
  })

  it("404s a non-staff org member (incl. an owner on no staff team)", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgStaffMock.mockReturnValue({ isStaff: false, roleResolved: true })
    render(<RequireRole>{child}</RequireRole>)
    expect(shown()).toBe("notfound")
  })

  it("shows a retryable error when the staff-team probes settle in error", () => {
    paramsMock.mockReturnValue({ org: "acme" })
    orgStaffMock.mockReturnValue({
      isStaff: false,
      roleResolved: false,
      isError: true,
      refetch: () => {},
    })
    render(<RequireRole>{child}</RequireRole>)
    expect(shown()).toBe("error")
  })
})
