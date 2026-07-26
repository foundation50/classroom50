// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"

const planDetails = vi.fn()
vi.mock("@/hooks/useGetOrgPlanDetails", () => ({
  default: () => planDetails(),
}))

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"

// Real i18n (English is bundled at init) rather than a key-returning stub: the
// copy IS this unit's deliverable — the remedy has to name both controls and
// disclose the enterprise pin — and <Trans> renders nothing under a stubbed
// useTranslation.
import "@/i18n"
import { OrgRepoCreationNotice } from "./OrgRepoCreationNotice"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// The notice's action is a RouterButton (createLink(Button)), which needs a live
// router — so render inside an isolated in-memory tree rather than stubbing Link.
// Mirrors RouterButton.test.tsx's harness.
function renderInRouter(node: ReactNode) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{node}</>,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$org/settings",
    component: () => <div>settings</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  return render(<RouterProvider router={router as unknown as never} />)
}

// A GET /orgs/{org} response carrying only the fields the hook reads. The other
// audited lockdown fields sit at their desired values so a test asserts the
// repo-creation verdict rather than unrelated drift.
const orgResponse = (over: Record<string, unknown> = {}) => ({
  data: {
    login: "acme",
    id: 1,
    plan: { name: "team" },
    members_can_create_repositories: true,
    members_can_create_private_repositories: true,
    ...over,
  },
  isPending: false,
  isError: false,
})

// Distinguishing fragments of the two remedies. The master switch and the
// private checkbox are different controls, so the copy must not be shared.
const MASTER = /doesn't let its members create repositories/
const PRIVATE = /doesn't let its members create private repositories/
const ACTION = "Organization settings"

describe("OrgRepoCreationNotice", () => {
  it("warns, naming the master switch, when repo creation is off", async () => {
    planDetails.mockReturnValue(
      orgResponse({
        // Team/Free slaves the granular booleans to the master switch, so a real
        // response has both off.
        members_can_create_repositories: false,
        members_can_create_private_repositories: false,
      }),
    )
    renderInRouter(<OrgRepoCreationNotice org="acme" />)

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(MASTER)
    expect(alert.textContent).not.toMatch(PRIVATE)

    // Load-bearing clauses, not styling: name Private, keep Public locked down,
    // and disclose that the remedy can be pinned out of reach.
    expect(alert.textContent).toContain('check "Private"')
    expect(alert.textContent).toContain('leave "Public" unchecked')
    expect(alert.textContent).toContain("enterprise")
    expect(alert.textContent).toContain("acme")
  })

  it("warns, naming the private checkbox, when only private creation is off", async () => {
    planDetails.mockReturnValue(
      orgResponse({ members_can_create_private_repositories: false }),
    )
    renderInRouter(<OrgRepoCreationNotice org="acme" />)

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(PRIVATE)
    expect(alert.textContent).toContain('check "Private"')
    expect(alert.textContent).toContain("enterprise")
  })

  it("stays silent when both switches are on", () => {
    planDetails.mockReturnValue(orgResponse())
    renderInRouter(<OrgRepoCreationNotice org="acme" />)

    expect(screen.queryByRole("alert")).toBeNull()
  })

  // Fails open: GitHub omits the member-privilege fields for a non-admin, and a
  // teacher who can't read the setting can't be told anything useful about it.
  // This is the one consumer that inverts classifyDefaults' fail-closed reading,
  // so without this case every non-admin teacher would see the warning.
  it("stays silent when the fields are absent (non-admin response)", () => {
    planDetails.mockReturnValue({
      data: { login: "acme", id: 1 },
      isPending: false,
      isError: false,
    })
    renderInRouter(<OrgRepoCreationNotice org="acme" />)

    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("stays silent while loading and when the read errored", () => {
    planDetails.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
    })
    const { unmount } = renderInRouter(<OrgRepoCreationNotice org="acme" />)
    expect(screen.queryByRole("alert")).toBeNull()
    unmount()

    planDetails.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
    })
    renderInRouter(<OrgRepoCreationNotice org="acme" />)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("stays silent without an org", () => {
    planDetails.mockReturnValue(
      orgResponse({ members_can_create_repositories: false }),
    )
    renderInRouter(<OrgRepoCreationNotice org={undefined} />)

    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("offers the in-app org-setup re-run and the manual member-privileges link", async () => {
    planDetails.mockReturnValue(
      orgResponse({
        members_can_create_repositories: false,
        members_can_create_private_repositories: false,
      }),
    )
    renderInRouter(<OrgRepoCreationNotice org="acme" />)

    // The in-app repair is the primary action: hand-fixing one toggle leaves the
    // rest of the audited lockdown unapplied.
    const action = await screen.findByText(ACTION)
    expect(action.closest("a")?.getAttribute("href")).toBe("/acme/settings")

    const manual = screen
      .getAllByRole("link")
      .find((el) =>
        el.getAttribute("href")?.includes("/settings/member_privileges"),
      )
    expect(manual?.getAttribute("href")).toContain("acme")
  })
})
