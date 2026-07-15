// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import type { ReactNode } from "react"

// The drawer's classroom nav affordances (Roster, Settings) are gated via the
// real can() policy off the resolved classroom role. Mock only the role signal
// + the router/i18n/asset boundaries the module needs to load — can() stays
// REAL so this pins the role -> can() wiring the pure policy tests can't reach.
const classroomCtxMock = vi.fn()

vi.mock("@/context/classroomRole/ClassroomRoleProvider", () => ({
  useClassroomRoleContext: () => classroomCtxMock(),
  useClassroomRoleContextOptional: () => classroomCtxMock(),
}))
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})
// Router Link -> a plain anchor carrying its target so we can assert which
// links render. Spread the real module so other router exports the drawer's
// module graph pulls in at load (createFileRoute, etc.) stay intact.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => (
      <a href={to} data-to={to}>
        {children}
      </a>
    ),
    useParams: () => ({}),
    useMatchRoute: () => () => false,
    useMatch: () => undefined,
    useNavigate: () => () => {},
  }
})
// Asset imports the drawer module pulls in at load time.
vi.mock("@/assets/github.svg?react", () => ({ default: () => null }))
vi.mock("@/assets/duck.png", () => ({ default: "" }))

import { TeacherSidebarMenu } from "./index"

// Roster is staff-only (instructor|ta); Settings is instructor-only. Both keyed
// off the resolved fine role via can().
const ctx = (over: Record<string, unknown> = {}) => ({
  role: "instructor",
  actualRole: "instructor",
  isLoading: false,
  isError: false,
  retry: () => {},
  roleResolved: true,
  ...over,
})

const links = () =>
  screen
    .queryAllByRole("link")
    .map((a) => a.getAttribute("data-to"))
    .filter(Boolean)

const hasRoster = () => links().some((to) => to === "/$org/$classroom/roster")
const hasSettings = () => links().some((to) => to === "/$org/$classroom/edit")
const hasSkeleton = () => document.querySelector(".skeleton") !== null

const renderMenu = () =>
  render(
    <TeacherSidebarMenu org="acme" classroom="cs101" selected="assignments" />,
  )

afterEach(() => {
  cleanup()
  classroomCtxMock.mockReset()
})

describe("TeacherSidebarMenu — RBAC nav affordances via can()", () => {
  it("an instructor sees Roster and Settings", () => {
    classroomCtxMock.mockReturnValue(ctx())
    renderMenu()
    expect(hasRoster()).toBe(true)
    expect(hasSettings()).toBe(true)
  })

  it("a TA sees Roster (staff) but not Settings (instructor-only)", () => {
    classroomCtxMock.mockReturnValue(ctx({ role: "ta", actualRole: "ta" }))
    renderMenu()
    expect(hasRoster()).toBe(true)
    expect(hasSettings()).toBe(false)
  })

  it("an instructor previewing as student sees neither (downgrade-only clamp)", () => {
    // role is the preview-clamped one; showStaffItems/canEditSettings key off it,
    // so a real instructor previewing as a student sees the student surface.
    classroomCtxMock.mockReturnValue(
      ctx({ role: "student", actualRole: "instructor" }),
    )
    renderMenu()
    expect(hasRoster()).toBe(false)
    expect(hasSettings()).toBe(false)
  })

  it("a student sees neither Roster nor Settings", () => {
    classroomCtxMock.mockReturnValue(
      ctx({ role: "student", actualRole: "student" }),
    )
    renderMenu()
    expect(hasRoster()).toBe(false)
    expect(hasSettings()).toBe(false)
  })

  it("shows skeleton placeholders (never staff items) while the role is unresolved", () => {
    classroomCtxMock.mockReturnValue(
      ctx({ role: "unresolved", roleResolved: false }),
    )
    renderMenu()
    expect(hasSkeleton()).toBe(true)
    expect(hasRoster()).toBe(false)
    expect(hasSettings()).toBe(false)
  })
})
