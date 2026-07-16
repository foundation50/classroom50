// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

// Drive the owner verdict and the two GitHub-derived status signals; assert the
// page's render branches (owner gate + derived wizard stage) without standing
// up the whole PageShell + GitHub client + mutation graph the page pulls at
// load.
const ownerMock = vi.fn()
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useIsOrgOwner: () => ownerMock(),
}))

const repoStatusMock = vi.fn()
const tokenStatusMock = vi.fn()
vi.mock("@/hooks/useOrgClassroom50Status", () => ({
  useOrgClassroom50Status: () => repoStatusMock(),
  orgClassroom50StatusKey: (org: string | undefined) => [
    "github",
    "repos",
    org,
    "classroom50",
    "exists",
  ],
}))
vi.mock("@/hooks/useGetServiceTokenStatus", () => ({
  default: () => tokenStatusMock(),
}))

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
    useParams: () => ({ org: "acme" }),
    Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  }
})
// Heavy boundaries the page mounts; stub to inert markers so the branch logic
// is what we exercise. OrgSettingsPane stays null for the pure stage-routing
// cases (stage 2 is asserted via the Back button the page owns).
vi.mock("@/components/PageShell", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/PageHeader", () => ({ default: () => null }))
// RouterButton renders a TanStack <Link>, which needs a RouterProvider we don't
// mount here; stub it to a plain button so the stage-3 finish screen renders.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>()
  return {
    ...actual,
    RouterButton: ({ children }: { children: ReactNode }) => (
      <button type="button">{children}</button>
    ),
  }
})
vi.mock("./OrgSettingsPage", () => ({ OrgSettingsPane: () => null }))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))
vi.mock("@/hooks/useGetOrgPlanDetails", () => ({
  default: () => ({ data: { plan: { name: "team" } }, isLoading: false }),
}))
vi.mock("@/github-core/mutations", () => ({
  initClassroom50: async () => ({ status: "ok" }),
}))
vi.mock("@/components/skeletonOverwrite/skeletonOverwriteUi", () => ({
  SkeletonOverwriteModal: () => null,
  useSkeletonOverwriteConfirm: () => ({
    overwritePaths: null,
    resolveOverwrite: () => {},
    confirmSkeletonOverwrite: async () => true,
  }),
}))

import OrgSetupPage from "./OrgSetupPage"

const retry = vi.fn()
const owner = (over: Record<string, unknown>) =>
  ownerMock.mockReturnValue({
    isOwner: false,
    isPending: false,
    isError: false,
    retry,
    ...over,
  })

const repoStatus = (over: Record<string, unknown> = {}) =>
  repoStatusMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...over,
  })

const tokenStatus = (over: Record<string, unknown> = {}) =>
  tokenStatusMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...over,
  })

const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={client}>
      <OrgSetupPage />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  ownerMock.mockReset()
  repoStatusMock.mockReset()
  tokenStatusMock.mockReset()
  retry.mockReset()
})

describe("OrgSetupPage owner gate", () => {
  it("owner-pending => spinner, no not-admin alert (no denial flash mid-load)", () => {
    owner({ isPending: true })
    repoStatus()
    tokenStatus()
    renderPage()
    expect(screen.queryByText("setup.notAdmin")).toBeNull()
    expect(screen.queryByText("setup.loadingSetup")).not.toBeNull()
  })

  it("settled owner-error => retry surface, not stranded, no not-admin alert", () => {
    owner({ isError: true })
    repoStatus()
    tokenStatus()
    renderPage()
    expect(screen.queryByText("setup.notAdmin")).toBeNull()
    expect(screen.queryByText("submissions.errors.retry")).not.toBeNull()
  })

  it("definitive non-owner => not-admin alert, no spinner", () => {
    owner({})
    repoStatus()
    tokenStatus()
    renderPage()
    expect(screen.queryByText("setup.notAdmin")).not.toBeNull()
    expect(screen.queryByText("setup.loadingSetup")).toBeNull()
  })
})

describe("OrgSetupPage derived wizard stage", () => {
  it("config missing => stage 1 (Run setup)", () => {
    owner({ isOwner: true })
    repoStatus({ data: "missing" })
    tokenStatus({ data: { status: "missing" } })
    renderPage()
    expect(screen.queryByText("setup.runSetup")).not.toBeNull()
    expect(screen.queryByText("setup.nextServiceToken")).toBeNull()
    expect(screen.queryByText("setup.allSetTitle")).toBeNull()
  })

  it("config ready, token missing => stage 1 shows Next (advances to stage 2)", () => {
    owner({ isOwner: true })
    repoStatus({ data: "ready" })
    tokenStatus({ data: { status: "missing" } })
    renderPage()
    // configReady surfaces the Next button instead of Run setup.
    expect(screen.queryByText("setup.nextServiceToken")).not.toBeNull()
    expect(screen.queryByText("setup.runSetup")).toBeNull()
    // Advancing lands on stage 2 (Back button appears).
    fireEvent.click(screen.getByText("setup.nextServiceToken"))
    expect(screen.queryByText("setup.back")).not.toBeNull()
  })

  it("#307 regression: token present on fresh mount => stage 3, not stage 1", () => {
    owner({ isOwner: true })
    repoStatus({ data: "ready" })
    tokenStatus({ data: { status: "present" } })
    renderPage()
    expect(screen.queryByText("setup.allSetTitle")).not.toBeNull()
    // The stuck loop was landing here on step 1 "Run setup" after reload.
    expect(screen.queryByText("setup.runSetup")).toBeNull()
    expect(screen.queryByText("setup.nextServiceToken")).toBeNull()
  })

  it("token 'unknown' status => retry surface, not a silent stage 1", () => {
    owner({ isOwner: true })
    repoStatus({ data: "ready" })
    tokenStatus({ data: { status: "unknown" } })
    renderPage()
    expect(screen.queryByText("setup.statusIndeterminate")).not.toBeNull()
    expect(screen.queryByText("setup.runSetup")).toBeNull()
  })

  it("config-probe error => retry surface, not a silent stage 1 (repo probe rethrows, no 'unknown' data)", () => {
    owner({ isOwner: true })
    // The config probe rethrows non-404s, so react-query surfaces isError with
    // data still undefined — it never resolves the string "unknown".
    repoStatus({ isError: true })
    tokenStatus({ data: { status: "missing" } })
    renderPage()
    expect(screen.queryByText("setup.statusIndeterminate")).not.toBeNull()
    expect(screen.queryByText("setup.runSetup")).toBeNull()
  })

  it("repo-probe loading => spinner, not a stage-1 flash", () => {
    owner({ isOwner: true })
    repoStatus({ isLoading: true })
    tokenStatus({ data: { status: "missing" } })
    renderPage()
    expect(screen.queryByText("setup.loadingSetup")).not.toBeNull()
    expect(screen.queryByText("setup.runSetup")).toBeNull()
  })

  it("token-probe loading => spinner, not a stage-1 flash", () => {
    owner({ isOwner: true })
    repoStatus({ data: "ready" })
    tokenStatus({ isLoading: true })
    renderPage()
    expect(screen.queryByText("setup.loadingSetup")).not.toBeNull()
    expect(screen.queryByText("setup.runSetup")).toBeNull()
  })
})

describe("OrgSetupPage wizard navigation", () => {
  it("stage 3 'Manage service token' returns to step 2 (back override beats derived floor)", () => {
    owner({ isOwner: true })
    repoStatus({ data: "ready" })
    tokenStatus({ data: { status: "present" } })
    renderPage()
    expect(screen.queryByText("setup.allSetTitle")).not.toBeNull()
    fireEvent.click(screen.getByText("setup.manageServiceToken"))
    // Now on stage 2: the Back button is shown, finish screen gone.
    expect(screen.queryByText("setup.back")).not.toBeNull()
    expect(screen.queryByText("setup.allSetTitle")).toBeNull()
  })

  it("stage 2 'Back' returns to step 1 even when configReady", () => {
    owner({ isOwner: true })
    repoStatus({ data: "ready" })
    tokenStatus({ data: { status: "missing" } })
    renderPage()
    fireEvent.click(screen.getByText("setup.nextServiceToken"))
    expect(screen.queryByText("setup.back")).not.toBeNull()
    fireEvent.click(screen.getByText("setup.back"))
    // Back drops below the derived floor (stage 2) to stage 1's Next button.
    expect(screen.queryByText("setup.nextServiceToken")).not.toBeNull()
    expect(screen.queryByText("setup.back")).toBeNull()
  })

  it("token present: Manage then Back returns to the finish screen, not a trap", () => {
    owner({ isOwner: true })
    repoStatus({ data: "ready" })
    tokenStatus({ data: { status: "present" } })
    renderPage()
    // Go to the token form from the finish screen…
    fireEvent.click(screen.getByText("setup.manageServiceToken"))
    expect(screen.queryByText("setup.back")).not.toBeNull()
    expect(screen.queryByText("setup.allSetTitle")).toBeNull()
    // …then Back returns to the derived floor (stage 3), not stage 1.
    fireEvent.click(screen.getByText("setup.back"))
    expect(screen.queryByText("setup.allSetTitle")).not.toBeNull()
    expect(screen.queryByText("setup.runSetup")).toBeNull()
  })
})
