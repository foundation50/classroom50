// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"

const getOrgActionsMode = vi.fn()
const isOrgOwner = vi.fn()

vi.mock("@/github-core/mutations", () => ({
  getOrgActionsMode: () => getOrgActionsMode(),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useOptionalGitHubClient: () => ({ request: vi.fn(), requestRaw: vi.fn() }),
}))
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useIsOrgOwner: () => isOrgOwner(),
}))

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

// Real i18n rather than a key-returning stub: the copy IS this unit's
// deliverable (it has to explain WHY the PR won't open and reassure that
// existing PRs survive), and <Trans> renders nothing under a stubbed
// useTranslation. Mirrors OrgRepoCreationNotice.test.tsx.
import "@/i18n"
import { FeedbackPrNotice } from "./FeedbackPrNotice"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// The banner variant's action is a RouterButton, which needs a live router.
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
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as unknown as never} />
    </QueryClientProvider>,
  )
}

const OWNER = {
  isOwner: true,
  isPending: false,
  isError: false,
  retry: () => {},
}
const WANTS = { feedback_pr: true, empty_repo: false }

const asOwnerWith = (mode: string) => {
  isOrgOwner.mockReturnValue(OWNER)
  getOrgActionsMode.mockResolvedValue(mode)
}

describe("FeedbackPrNotice", () => {
  it("warns and names the pause as the cause", async () => {
    asOwnerWith("paused")
    renderInRouter(<FeedbackPrNotice org="acme" assignment={WANTS} />)

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/Autograding is paused/)
    expect(alert.textContent).toContain("acme")

    // Load-bearing clauses, not styling: explain that the PR is opened by the
    // autograder inside the student repo (so the coupling is understandable),
    // and reassure that already-open PRs remain reviewable — otherwise a
    // teacher may think pausing destroyed in-flight review work.
    expect(alert.textContent).toMatch(/inside each student repository/)
    expect(alert.textContent).toMatch(/stay open and reviewable/)
  })

  it("distinguishes org-wide disabled Actions from a pause", async () => {
    asOwnerWith("disabled")
    renderInRouter(<FeedbackPrNotice org="acme" assignment={WANTS} />)

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/GitHub Actions is off/)
    expect(alert.textContent).not.toMatch(/Autograding is paused/)
  })

  it("stays silent when autograding is active", async () => {
    asOwnerWith("active")
    renderInRouter(<FeedbackPrNotice org="acme" assignment={WANTS} />)
    await waitFor(() => expect(getOrgActionsMode).toHaveBeenCalled())
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("stays silent when the assignment doesn't want a feedback PR", async () => {
    asOwnerWith("paused")
    renderInRouter(
      <FeedbackPrNotice
        org="acme"
        assignment={{ feedback_pr: false, empty_repo: false }}
      />,
    )
    // Never reads: the subject opted out, so there is nothing to warn about.
    expect(getOrgActionsMode).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("stays silent without an org", () => {
    asOwnerWith("paused")
    renderInRouter(<FeedbackPrNotice org={undefined} assignment={WANTS} />)
    expect(getOrgActionsMode).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("offers the in-app org settings action in the banner variant", async () => {
    asOwnerWith("paused")
    renderInRouter(<FeedbackPrNotice org="acme" assignment={WANTS} />)

    const action = await screen.findByText("Organization settings")
    expect(action.closest("a")?.getAttribute("href")).toBe("/acme/settings")
  })

  // The inline variant sits beside the toggle it annotates, where a page-width
  // navigation button would outweigh the control.
  it("omits the navigation action in the inline variant", async () => {
    asOwnerWith("paused")
    renderInRouter(
      <FeedbackPrNotice org="acme" assignment={WANTS} variant="inline" />,
    )

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/Autograding is paused/)
    expect(screen.queryByText("Organization settings")).toBeNull()
  })
})
