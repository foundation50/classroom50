// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// i18n as identity, but expand the count-bearing keys so we can assert the
// number that actually reaches the label (interpolation is what matters here).
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

const studentCount = vi.fn()
const assignments = vi.fn()

vi.mock("@/hooks/useStudentCount", () => ({
  default: (...a: unknown[]) => studentCount(...a),
}))
vi.mock("@/hooks/useGetClassAssignments", () => ({
  default: (...a: unknown[]) => assignments(...a),
}))

import { ClassroomStats } from "./ClassroomCard"

beforeEach(() => {
  studentCount.mockReset()
  assignments.mockReset()
  // Assignments resolved with none, so the assignment stat never confuses the
  // student-stat assertions below.
  assignments.mockReturnValue({
    data: { assignments: [] },
    isPending: false,
    isError: false,
    error: null,
  })
})

afterEach(cleanup)

describe("ClassroomStats student count", () => {
  it("renders the role-aware student count, not total roster rows", () => {
    // 11 students even though the roster carries 14 rows (staff included).
    studentCount.mockReturnValue({
      studentCount: 11,
      isLoading: false,
      isError: false,
    })
    render(<ClassroomStats org="acme" slug="cs101" />)
    expect(screen.getByText("classes.studentCount:11")).toBeTruthy()
  })

  it("renders the noStudents string when the count is zero", () => {
    studentCount.mockReturnValue({
      studentCount: 0,
      isLoading: false,
      isError: false,
    })
    render(<ClassroomStats org="acme" slug="cs101" />)
    expect(screen.getByText("classes.noStudents")).toBeTruthy()
  })

  it("shows the loading label until the count resolves", () => {
    studentCount.mockReturnValue({
      studentCount: undefined,
      isLoading: true,
      isError: false,
    })
    render(<ClassroomStats org="acme" slug="cs101" />)
    expect(screen.getByText("classes.card.loadingStudents")).toBeTruthy()
  })

  it("shows counts-unavailable on a role-count error, never a wrong 0", () => {
    studentCount.mockReturnValue({
      studentCount: undefined,
      isLoading: false,
      isError: true,
    })
    render(<ClassroomStats org="acme" slug="cs101" />)
    expect(screen.getByText("classes.card.countsUnavailable")).toBeTruthy()
    expect(screen.queryByText("classes.noStudents")).toBeNull()
  })
})
