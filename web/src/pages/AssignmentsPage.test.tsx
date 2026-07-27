// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import type { ReactNode } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { count?: number }) =>
        opts && "count" in opts ? `${key}:${opts.count}` : key,
    }),
  }
})

// Router Link needs a RouterProvider; stub it to a plain anchor so the header's
// New Assignment button renders without router context.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
    useParams: () => ({ org: "acme", classroom: "cs101" }),
  }
})

const studentCount = vi.fn()
const getStudents = vi.fn()
const getClassroom = vi.fn()
const getAssignments = vi.fn()

vi.mock("@/hooks/useStudentCount", () => ({
  default: (...a: unknown[]) => studentCount(...a),
}))
vi.mock("@/hooks/useGetStudents", () => ({
  default: (...a: unknown[]) => getStudents(...a),
}))
vi.mock("@/hooks/useGetClassroom", () => ({
  default: (...a: unknown[]) => getClassroom(...a),
}))
vi.mock("@/hooks/useGetClassAssignments", () => ({
  default: (...a: unknown[]) => getAssignments(...a),
}))
vi.mock("@/hooks/useEmptyRosterWarning", () => ({
  default: () => ({ show: false, hasRosterRows: false }),
}))
const orgRepoCreationWarning = vi.fn()
vi.mock("@/hooks/useOrgRepoCreationWarning", () => ({
  default: () => orgRepoCreationWarning(),
}))
// The notice's own copy/placement is covered in OrgRepoCreationNotice.test.tsx;
// here it stands in for "did the page mount it", so stub it to its i18n key.
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
vi.mock("@/context/classroomRole/ClassroomRoleProvider", () => ({
  useClassroomRoleContext: () => ({ role: "teacher" }),
}))
// Stub the heavy children so the test targets only the header subtitle.
vi.mock("@/pages/assignments/AssignmentsTable", () => ({ default: () => null }))
vi.mock("@/pages/assignments/AssignmentsToolbar", () => ({
  default: () => null,
}))

import { TeacherAssignmentsView } from "./AssignmentsPage"

beforeEach(() => {
  orgRepoCreationWarning.mockReturnValue({ show: false })
  studentCount.mockReset()
  getStudents.mockReset()
  getClassroom.mockReset()
  getAssignments.mockReset()
  getStudents.mockReturnValue({ students: [] })
  getClassroom.mockReturnValue({ data: { name: "CS 101" }, isLoading: false })
  getAssignments.mockReturnValue({
    data: { assignments: [] },
    isLoading: false,
  })
})

afterEach(cleanup)

describe("Assignments header student count", () => {
  it("renders the role-aware count, not the total roster row count", () => {
    getStudents.mockReturnValue({ students: new Array(14).fill({}) })
    studentCount.mockReturnValue({
      studentCount: 11,
      isLoading: false,
      isError: false,
    })
    render(<TeacherAssignmentsView org="acme" classroom="cs101" />)
    expect(screen.getByText(/assignments\.studentCount:11/)).toBeTruthy()
  })

  it("shows the loading placeholder until the count resolves", () => {
    studentCount.mockReturnValue({
      studentCount: undefined,
      isLoading: true,
      isError: false,
    })
    render(<TeacherAssignmentsView org="acme" classroom="cs101" />)
    expect(screen.getByText("…")).toBeTruthy()
  })

  it("shows the placeholder on a role-count error, not a wrong number", () => {
    studentCount.mockReturnValue({
      studentCount: undefined,
      isLoading: false,
      isError: true,
    })
    render(<TeacherAssignmentsView org="acme" classroom="cs101" />)
    expect(screen.getByText("…")).toBeTruthy()
    expect(screen.queryByText(/assignments\.studentCount/)).toBeNull()
  })
})

// The drift-after-creation case: a teacher who created assignments before the
// setting flipped never reopens create or edit, so without the list surface the
// warning never reaches them and students accept days later.
describe("Assignments org repo-creation warning", () => {
  const renderView = () => {
    studentCount.mockReturnValue({
      studentCount: 1,
      isLoading: false,
      isError: false,
    })
    render(<TeacherAssignmentsView org="acme" classroom="cs101" />)
  }

  it("renders the notice when the org blocks repo creation", () => {
    orgRepoCreationWarning.mockReturnValue({ show: true, field: "master" })
    renderView()
    expect(
      screen.queryByText("components.notices.orgRepoCreation.master"),
    ).not.toBeNull()
  })

  it("renders nothing when the hook is silent", () => {
    orgRepoCreationWarning.mockReturnValue({ show: false })
    renderView()
    expect(
      screen.queryByText("components.notices.orgRepoCreation.master"),
    ).toBeNull()
    expect(
      screen.queryByText("components.notices.orgRepoCreation.private"),
    ).toBeNull()
  })
})
