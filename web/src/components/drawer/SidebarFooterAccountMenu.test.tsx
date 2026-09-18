// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

import { SidebarFooter } from "./SidebarFooter"

vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({
    status: "authenticated",
    signOut: vi.fn(),
    user: { login: "octocat", name: "Octocat", avatar_url: "" },
  }),
}))
vi.mock("@/hooks/useOrgStaff", () => ({
  useOrgStaff: () => ({ isNonStaff: false, isLoading: false }),
}))
vi.mock("@/hooks/useGetOrgPlanDetails", () => ({
  default: () => ({ data: undefined }),
}))
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useIsOrgOwner: () => ({
    isOwner: false,
    isPending: false,
    isError: false,
  }),
}))
vi.mock("@/context/classroomRole/ClassroomRoleProvider", () => ({
  useClassroomRoleContextOptional: () => null,
}))
vi.mock("@/context/roleView/RoleViewProvider", () => ({
  useRoleView: () => ({ viewAs: null, setViewAs: vi.fn() }),
}))
vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ isDark: false, toggleTheme: vi.fn() }),
}))
vi.mock("./collapseContext", () => ({
  useSidebarCollapse: () => ({ collapsed: false }),
}))
vi.mock("./DeployEnvBadge", () => ({ DeployEnvBadge: () => null }))
vi.mock("@/components/LanguageDialog", () => ({
  LanguageDialog: () => null,
}))
vi.mock("@/components/AboutDialog", () => ({ AboutDialog: () => null }))
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => (
      <a href={to}>{children}</a>
    ),
    useParams: () => ({}),
    useMatchRoute: () => () => false,
    useMatch: () => undefined,
    useNavigate: () => () => {},
  }
})
vi.mock("@/assets/duck.png", () => ({ default: "" }))

afterEach(cleanup)

// The menu is a top-layer popover whose rows unmount on close, so Escape from
// a focused row has to hand focus back to the trigger explicitly or the
// keyboard user lands on <body>.
describe("SidebarFooter account menu", () => {
  it("closes on Escape from a focused row and refocuses the trigger", () => {
    render(<SidebarFooter />)
    const trigger = screen.getByRole("button", { name: "nav.accountMenu" })
    fireEvent.click(trigger)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")

    const signOut = screen.getByRole("button", { name: "nav.signOut" })
    signOut.focus()
    fireEvent.keyDown(signOut, { key: "Escape" })

    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByRole("button", { name: "nav.signOut" })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it("closes on an outside pointer-down without moving focus", () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <SidebarFooter />
      </>,
    )
    const trigger = screen.getByRole("button", { name: "nav.accountMenu" })
    fireEvent.click(trigger)
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" })
    elsewhere.focus()
    fireEvent.pointerDown(elsewhere)

    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(document.activeElement).toBe(elsewhere)
  })
})
