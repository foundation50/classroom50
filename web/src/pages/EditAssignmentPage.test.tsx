// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
    useParams: () => ({
      org: "acme",
      classroom: "cs101",
      assignment: "hello-python",
    }),
    useRouter: () => ({ history: { back: vi.fn() } }),
  }
})

const role = vi.fn()
vi.mock("@/context/classroomRole/ClassroomRoleProvider", () => ({
  useClassroomRoleContext: () => ({ role: role() }),
}))

const orgRepoCreationWarning = vi.fn()
vi.mock("@/hooks/useOrgRepoCreationWarning", () => ({
  default: () => orgRepoCreationWarning(),
}))
// The notice's own copy is covered in OrgRepoCreationNotice.test.tsx; here it
// stands in for "did the page mount it, and did it fire the org read".
vi.mock("@/components/OrgRepoCreationNotice", async () => {
  const { default: useWarning } =
    await import("@/hooks/useOrgRepoCreationWarning")
  return {
    OrgRepoCreationNotice: () => {
      const warning = useWarning(undefined)
      if (!warning.show) return null
      return <div>{`components.notices.orgRepoCreation.${warning.field}`}</div>
    },
  }
})

vi.mock("@/components/PageShell", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/PageHeader", () => ({ default: () => null }))
vi.mock("@/components/breadcrumb", () => ({ default: () => null }))
vi.mock("./assignments/EditAssignmentForm", () => ({ default: () => null }))
// EditAssignmentFormStudent is defined in the page module itself, so it can't be
// stubbed — stub the auth context it reads instead, keeping the student branch on
// its real render path (which is what the R12 assertion below is about).
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { id: 1, login: "student" } }),
}))
vi.mock("@/hooks/useGetAssignmentRepo", () => ({
  default: () => ({ data: null, isLoading: false }),
}))
vi.mock("@/hooks/useGetPublicAssignment", () => ({
  default: () => ({ data: null, isLoading: false }),
}))
vi.mock("@/hooks/useDotClassroom50", () => ({
  default: () => ({ data: null, isLoading: false }),
}))
vi.mock("@/hooks/useDocumentTitle", () => ({
  useDocumentTitle: () => undefined,
}))
vi.mock("@/hooks/useGetClassAssignments", () => ({
  default: () => ({
    data: { assignments: [{ slug: "hello-python", name: "Hello Python" }] },
  }),
}))
vi.mock("@/hooks/useGetClassroom", () => ({
  default: () => ({ data: { name: "CS 101", active: true } }),
}))

import EditAssignmentPage from "./EditAssignmentPage"

beforeEach(() => {
  orgRepoCreationWarning.mockReturnValue({ show: false })
  role.mockReturnValue("teacher")
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const NOTICE = "components.notices.orgRepoCreation.master"

// This page has no RequireRole wrapper and renders a student form on the student
// branch, so the notice's placement inside the isStaff branch is the only thing
// keeping a student from seeing a warning about org member privileges — and from
// firing an org read they could never act on.
describe("EditAssignmentPage org repo-creation warning", () => {
  it("renders the notice for a staff role", () => {
    orgRepoCreationWarning.mockReturnValue({ show: true, field: "master" })
    render(<EditAssignmentPage />)
    expect(screen.queryByText(NOTICE)).not.toBeNull()
  })

  it("is absent for a student, even when the org blocks repo creation", () => {
    orgRepoCreationWarning.mockReturnValue({ show: true, field: "master" })
    role.mockReturnValue("student")
    render(<EditAssignmentPage />)

    expect(screen.queryByText(NOTICE)).toBeNull()
    // Not merely hidden: the org read never runs for a student.
    expect(orgRepoCreationWarning).not.toHaveBeenCalled()
  })

  it("renders nothing for staff when the hook is silent", () => {
    render(<EditAssignmentPage />)
    expect(screen.queryByText(NOTICE)).toBeNull()
  })
})
