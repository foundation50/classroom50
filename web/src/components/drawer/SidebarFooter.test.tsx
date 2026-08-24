// @vitest-environment happy-dom
import { describe, expect, it, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import type { ReactNode } from "react"

import { SidebarFooter, ThemeToggleTrack } from "./SidebarFooter"

// The public /accessibility page mounts this footer with NO GitHub client. The
// authed-only hooks must therefore never run for a signed-out visitor; wire
// them to throw so a regression that reintroduces one into the public path
// fails loudly here instead of only at runtime for a real reviewer.
const clientHookCalled = vi.fn()
vi.mock("@/hooks/useOrgStaff", () => ({
  useOrgStaff: () => {
    clientHookCalled()
    throw new Error("useOrgStaff must not run on the public footer")
  },
}))
vi.mock("@/hooks/useGetOrgPlanDetails", () => ({
  default: () => {
    clientHookCalled()
    throw new Error("useGetOrgPlanDetails must not run on the public footer")
  },
}))
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useIsOrgOwner: () => {
    clientHookCalled()
    throw new Error("useIsOrgOwner must not run on the public footer")
  },
}))

const authStatus = vi.fn(() => "unauthenticated")
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ status: authStatus() }),
}))
vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ isDark: false, toggleTheme: vi.fn() }),
}))
vi.mock("./collapseContext", () => ({
  useSidebarCollapse: () => ({ collapsed: false }),
}))
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
vi.mock("@/assets/duck.png", () => ({ default: "" }))

afterEach(cleanup)

// The branch's core intent: the public accessibility footer renders for a
// signed-out visitor without any GitHub client, so it must show the shared info
// controls and none of the account-menu surface.
describe("SidebarFooter — public (signed-out) variant", () => {
  it("renders the shared info controls without touching a client hook", () => {
    render(<SidebarFooter />)
    expect(clientHookCalled).not.toHaveBeenCalled()
    // Shared info controls are present…
    expect(screen.getByText("nav.language")).toBeDefined()
    expect(screen.getByText("nav.about")).toBeDefined()
    expect(screen.getByText("nav.accessibility")).toBeDefined()
    expect(screen.getByText("nav.docs")).toBeDefined()
    // …and the authed account menu is not.
    expect(screen.queryByLabelText("nav.accountMenu")).toBeNull()
    expect(screen.queryByText("nav.signOut")).toBeNull()
  })
})

// The theme toggle is presentational (aria-hidden, not a form control) so it
// can't reintroduce the nested-interactive axe violation. Its whole job is to
// mirror the on/off state visually — a regression here (e.g. a DaisyUI .toggle
// span that never moves its knob) is silent, so assert the state-driven classes.
describe("ThemeToggleTrack", () => {
  it("fills the track and slides the knob right when on (dark mode)", () => {
    render(<ThemeToggleTrack on={true} />)
    const track = screen.getByTestId("theme-toggle-track")
    const knob = screen.getByTestId("theme-toggle-knob")
    expect(track.className).toContain("bg-primary")
    expect(knob.className).toContain("translate-x-4")
    // never a real form control (would nest inside the theme button)
    expect(track.querySelector("input")).toBeNull()
  })

  it("uses the muted track and keeps the knob left when off (light mode)", () => {
    render(<ThemeToggleTrack on={false} />)
    const track = screen.getByTestId("theme-toggle-track")
    const knob = screen.getByTestId("theme-toggle-knob")
    expect(track.className).toContain("bg-base-content/30")
    expect(track.className).not.toContain("bg-primary")
    expect(knob.className).not.toContain("translate-x-4")
  })

  it("stays hidden from assistive tech", () => {
    render(<ThemeToggleTrack on={true} />)
    expect(
      screen.getByTestId("theme-toggle-track").getAttribute("aria-hidden"),
    ).toBe("true")
  })
})
