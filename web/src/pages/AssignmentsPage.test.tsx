// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
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

const funnelRoster = vi.fn()
const getStudents = vi.fn()
const getClassroom = vi.fn()
const getAssignments = vi.fn()

vi.mock("@/hooks/useFunnelRoster", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useFunnelRoster")>()
  return { ...actual, default: (...a: unknown[]) => funnelRoster(...a) }
})
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
// The table mock echoes the funnel props so the toggle's effect is observable.
vi.mock("@/pages/assignments/AssignmentsTable", () => ({
  default: ({
    roster,
    includeStaff,
  }: {
    roster?: { counted: ReadonlySet<string> }
    includeStaff?: boolean
  }) => (
    <div
      data-testid="table"
      data-counted={roster ? [...roster.counted].sort().join(",") : ""}
      data-include-staff={String(Boolean(includeStaff))}
    />
  ),
}))
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
import { INCLUDE_STAFF_STORAGE_KEY } from "@/lib/includeStaffPref"

// happy-dom doesn't back window.localStorage here, so install a minimal
// in-memory store (same shape the HiddenOrgsProvider / useTheme tests use).
function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size
      },
    },
    configurable: true,
  })
}

// A resolved funnel roster: `students` and `staff` logins (staff may overlap).
const resolvedRoster = (students: string[], staff: string[] = []) => ({
  studentLogins: new Set(students),
  staffLogins: new Set(staff),
  isLoading: false,
  isError: false,
  isUnknown: false,
})

beforeEach(() => {
  installLocalStorage()
  orgRepoCreationWarning.mockReturnValue({ show: false })
  funnelRoster.mockReset()
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
    funnelRoster.mockReturnValue(
      resolvedRoster(
        Array.from({ length: 11 }, (_, i) => `s${i}`),
        ["prof", "ta"],
      ),
    )
    render(<TeacherAssignmentsView org="acme" classroom="cs101" />)
    expect(screen.getByText(/assignments\.studentCount:11/)).toBeTruthy()
    expect(screen.queryByText(/assignments\.staffCount/)).toBeNull()
  })

  it("shows the loading placeholder until the count resolves", () => {
    funnelRoster.mockReturnValue({
      studentLogins: undefined,
      staffLogins: undefined,
      isLoading: true,
      isError: false,
      isUnknown: false,
    })
    render(<TeacherAssignmentsView org="acme" classroom="cs101" />)
    expect(screen.getByText("…")).toBeTruthy()
  })

  it("hides the count entirely on a role-count error, not a wrong number", () => {
    funnelRoster.mockReturnValue({
      studentLogins: undefined,
      staffLogins: undefined,
      isLoading: false,
      isError: true,
      isUnknown: false,
    })
    render(<TeacherAssignmentsView org="acme" classroom="cs101" />)
    // Not the loading "…" either — that reads as still-loading forever.
    expect(screen.queryByText("…")).toBeNull()
    expect(screen.queryByText(/assignments\.studentCount/)).toBeNull()
  })
})

// The "Include teaching staff" toggle widens what the table counts from the
// student team to the union of the student and staff teams (#860), and is
// remembered per browser.
describe("Include teaching staff toggle", () => {
  const assignments = [{ slug: "hw1", mode: "individual" }]
  const renderView = () => {
    getAssignments.mockReturnValue({ data: { assignments }, isLoading: false })
    // "dual" is a TA who is also on the student team: counted once.
    funnelRoster.mockReturnValue(
      resolvedRoster(["alice", "dual"], ["prof", "dual"]),
    )
    render(<TeacherAssignmentsView org="acme" classroom="cs101" />)
  }
  const toggle = () =>
    screen.getByRole("checkbox", { name: /assignments\.includeStaff/ })
  const table = () => screen.getByTestId("table")

  it("counts students only by default", () => {
    renderView()
    expect(table().dataset.counted).toBe("alice,dual")
    expect(table().dataset.includeStaff).toBe("false")
  })

  it("adds staff to the counted set, once each, when switched on", () => {
    renderView()
    fireEvent.click(toggle())
    expect(table().dataset.counted).toBe("alice,dual,prof")
    expect(table().dataset.includeStaff).toBe("true")
    // The header adds the staff-only head count so the denominator adds up.
    expect(screen.getByText(/assignments\.staffCount:1/)).toBeTruthy()
  })

  it("persists the choice and restores it on the next render", () => {
    renderView()
    fireEvent.click(toggle())
    expect(window.localStorage.getItem(INCLUDE_STAFF_STORAGE_KEY)).toBe("1")
    cleanup()
    renderView()
    expect(table().dataset.counted).toBe("alice,dual,prof")
  })

  it("is absent on an archived classroom", () => {
    getClassroom.mockReturnValue({
      data: { name: "CS 101", active: false },
      isLoading: false,
    })
    renderView()
    expect(
      screen.queryByRole("checkbox", { name: /assignments\.includeStaff/ }),
    ).toBeNull()
  })
})

// The drift-after-creation case: a teacher who created assignments before the
// setting flipped never reopens create or edit, so without the list surface the
// warning never reaches them and students accept days later.
describe("Assignments org repo-creation warning", () => {
  const renderView = () => {
    funnelRoster.mockReturnValue(resolvedRoster(["alice"]))
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
    funnelRoster.mockReturnValue(resolvedRoster(["alice"]))
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
