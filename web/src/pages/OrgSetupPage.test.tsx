// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

// Drive the owner verdict; assert the page's four render branches (pending /
// settled-error / definitive non-owner / owner) without standing up the whole
// PageShell + GitHub client + mutation graph the page pulls at load.
const ownerMock = vi.fn()
vi.mock("@/context/orgRole/useIsOrgOwner", () => ({
  useIsOrgOwner: () => ownerMock(),
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
    Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  }
})
// Heavy boundaries the page mounts; stub to inert markers so the branch logic
// is what we exercise.
vi.mock("@/components/PageShell", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/PageHeader", () => ({ default: () => null }))
vi.mock("./OrgSettingsPage", () => ({ OrgSettingsPane: () => null }))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))
vi.mock("@/hooks/useGetOrgPlanDetails", () => ({
  default: () => ({ data: { plan: { name: "team" } }, isLoading: false }),
}))
vi.mock("@/hooks/github/mutations", () => ({
  initClassroom50: async () => ({ status: "ok" }),
}))
vi.mock("./orgSettings/skeletonOverwriteUi", () => ({
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
  retry.mockReset()
})

describe("OrgSetupPage owner gate", () => {
  it("owner-pending => spinner, no not-admin alert (no denial flash mid-load)", () => {
    owner({ isPending: true })
    renderPage()
    expect(screen.queryByText("setup.notAdmin")).toBeNull()
    expect(screen.queryByText("setup.loadingSetup")).not.toBeNull()
  })

  it("settled owner-error => retry surface, not stranded, no not-admin alert", () => {
    owner({ isError: true })
    renderPage()
    expect(screen.queryByText("setup.notAdmin")).toBeNull()
    expect(screen.queryByText("submissions.errors.retry")).not.toBeNull()
  })

  it("definitive non-owner => not-admin alert, no spinner", () => {
    owner({})
    renderPage()
    expect(screen.queryByText("setup.notAdmin")).not.toBeNull()
    expect(screen.queryByText("setup.loadingSetup")).toBeNull()
  })

  it("confirmed owner => setup steps, no not-admin alert", () => {
    owner({ isOwner: true })
    renderPage()
    expect(screen.queryByText("setup.notAdmin")).toBeNull()
    // OrgSteps renders the step board / heading rather than the deny alert.
    expect(screen.queryByText("submissions.errors.retry")).toBeNull()
  })
})
