// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import type { ReactNode } from "react"

// Match assertions on stable i18n keys, not English copy; keep the rest of
// react-i18next real so <Trans> and the transitive setup still load.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

// The router <Link> renders as an anchor in isolation; stub it so we don't need
// a RouterProvider just to assert which notice shows.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  // The ui barrel pulls RouterButton, which calls createLink at module scope.
  createLink: (component: unknown) => component,
}))

import type { OrgAuditReport } from "@/orgPolicy/audit"

const tokenStatus = vi.fn()
const planDetails = vi.fn()
const audit = vi.fn()

vi.mock("@/hooks/useGetServiceTokenStatus", () => ({
  default: () => tokenStatus(),
}))
vi.mock("@/hooks/useGetOrgPlanDetails", () => ({
  default: () => planDetails(),
}))
vi.mock("@/hooks/useGetOrgAudit", () => ({ default: () => audit() }))

import OrgPreflightNotice from "./OrgPreflightNotice"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// Minimal report; only the fields OrgPreflightNotice reads matter.
const report = (over: Partial<OrgAuditReport>): { data: OrgAuditReport } => ({
  data: {
    org: "acme",
    plan: "team",
    verdict: "ok",
    readOk: true,
    lockdownComplete: true,
    unenforcedDefaults: [],
    defaultVerdicts: [],
    concerns: [],
    manualUnreadable: [],
    recommendations: [],
    ...over,
  } as OrgAuditReport,
})

const settled = () => {
  tokenStatus.mockReturnValue({ data: { status: "present" }, isPending: false })
  planDetails.mockReturnValue({
    data: { plan: { name: "team" } },
    isPending: false,
  })
}

const unreadableBudget = {
  id: "orgBudget" as const,
  title: "Actions spending cap",
  verdict: { state: "unreadable" as const },
  settingsUrl: "https://github.com/organizations/acme/settings/billing/budgets",
}

describe("OrgPreflightNotice", () => {
  it("stays invisible while any input is still loading", () => {
    tokenStatus.mockReturnValue({ data: undefined, isPending: true })
    planDetails.mockReturnValue({ data: undefined, isPending: false })
    audit.mockReturnValue({ data: undefined, isLoading: true })
    const { container } = render(<OrgPreflightNotice org="acme" />)
    expect(container.firstChild).toBeNull()
  })

  it("shows the hard error banner when the policy audit fails", () => {
    settled()
    audit.mockReturnValue(report({ verdict: "fail" }))
    render(<OrgPreflightNotice org="acme" />)
    expect(screen.getByText("orgSettings.preflight.title")).not.toBeNull()
    // The neutral cap-unverified notice must NOT also show.
    expect(
      screen.queryByText("orgSettings.preflight.unverifiedTitle"),
    ).toBeNull()
  })

  it("shows a neutral warning (not the failure banner) when the budget is unreadable but the verdict is ok", () => {
    settled()
    audit.mockReturnValue(
      report({ verdict: "ok", concerns: [unreadableBudget] }),
    )
    const { container } = render(<OrgPreflightNotice org="acme" />)
    expect(
      screen.getByText("orgSettings.preflight.unverifiedTitle"),
    ).not.toBeNull()
    // Never gates: the hard-failure banner stays hidden, and the callout is
    // warning-toned, not error.
    expect(screen.queryByText("orgSettings.preflight.title")).toBeNull()
    expect(container.querySelector(".alert-warning")).not.toBeNull()
    expect(container.querySelector(".alert-error")).toBeNull()
  })

  it("shows the failure banner (not the warning) when the audit fails AND the budget is unreadable", () => {
    settled()
    audit.mockReturnValue(
      report({ verdict: "fail", concerns: [unreadableBudget] }),
    )
    render(<OrgPreflightNotice org="acme" />)
    expect(screen.getByText("orgSettings.preflight.title")).not.toBeNull()
    expect(
      screen.queryByText("orgSettings.preflight.unverifiedTitle"),
    ).toBeNull()
  })

  it("stays fully invisible when everything is clean and readable", () => {
    settled()
    audit.mockReturnValue(report({ verdict: "ok", concerns: [] }))
    const { container } = render(<OrgPreflightNotice org="acme" />)
    expect(container.firstChild).toBeNull()
  })
})
