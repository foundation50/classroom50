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
    Link: ({ children }: { children?: ReactNode }) => (
      <a href="/mock">{children}</a>
    ),
    useParams: () => ({ org: "acme", classroom: "cs101" }),
  }
})

// RouterButton (createLink) needs a router context; stub just that primitive
// to a plain anchor so the page renders without a RouterProvider.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>()
  return {
    ...actual,
    RouterButton: ({ children }: { children?: ReactNode }) => (
      <a href="/mock">{children}</a>
    ),
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
// Stub the heavy children so the test targets only the page's own wiring. The
// toolbar mock exposes its slots so the collect-action gating is observable;
// the collect button itself is covered in ClassroomCollectButton.test.tsx.
vi.mock("@/pages/assignments/AssignmentsTable", () => ({ default: () => null }))
vi.mock("@/pages/assignments/AssignmentsToolbar", () => ({
  default: ({
    leading,
    trailing,
  }: {
    leading?: ReactNode
    trailing?: ReactNode
  }) => (
    <div>
      <div data-testid="toolbar-leading">{leading}</div>
      <div data-testid="toolbar-trailing">{trailing}</div>
    </div>
  ),
}))
vi.mock("@/pages/assignments/ClassroomCollectButton", () => {
  const stub = () => <div data-testid="collect-all" />
  return { ClassroomCollectButton: stub, default: stub }
})

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

// The classroom-wide collect's page-level gating: the component's own tests
// exercise it with props already supplied, so the show/hide decisions live
// here — visible for staff once assignments exist, gone when archived or
// while the list is empty (nothing to collect for).
describe("Classroom-wide collect visibility", () => {
  const assignments = [{ slug: "hw1", type: "individual" }]
  const renderView = () => {
    studentCount.mockReturnValue({
      studentCount: 1,
      isLoading: false,
      isError: false,
    })
    render(<TeacherAssignmentsView org="acme" classroom="cs101" />)
  }

  it("leads the toolbar once assignments exist", () => {
    getAssignments.mockReturnValue({
      data: { assignments },
      isLoading: false,
    })
    renderView()
    const leading = screen.getByTestId("toolbar-leading")
    expect(leading.querySelector('[data-testid="collect-all"]')).not.toBeNull()
  })

  it("is absent while the classroom has no assignments", () => {
    renderView()
    expect(screen.queryByTestId("collect-all")).toBeNull()
  })

  it("is absent on an archived classroom", () => {
    getClassroom.mockReturnValue({
      data: { name: "CS 101", active: false },
      isLoading: false,
    })
    getAssignments.mockReturnValue({
      data: { assignments },
      isLoading: false,
    })
    renderView()
    expect(screen.queryByTestId("collect-all")).toBeNull()
  })
})
