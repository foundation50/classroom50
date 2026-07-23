// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

vi.mock("react-i18next", async (importActual) => {
  const actual = await importActual<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

const planDetails = vi.fn()
vi.mock("@/hooks/useGetOrgPlanDetails", () => ({
  default: (...a: unknown[]) => planDetails(...a),
}))

// happy-dom lacks <dialog> showModal/close; stub them so <Modal> renders open.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

import OrgDetailsModal from "./OrgDetailsModal"
import type { Classroom50OrgSummary } from "@/github-core/queries"

const summary = (
  overrides?: Partial<Classroom50OrgSummary["org"]>,
  role: "admin" | "member" = "admin",
): Classroom50OrgSummary => ({
  org: {
    login: "classroom50-summer-dev",
    id: 4242,
    avatar_url: "https://example.com/a.png",
    description: "Summer cohort",
    html_url: "https://github.com/classroom50-summer-dev",
    ...overrides,
  },
  membership: { state: "active", role },
  classroom50: {
    status: "ready",
    canAccessRepo: true,
    canInitialize: false,
    pagesUrl: "",
  },
})

afterEach(() => {
  cleanup()
  planDetails.mockReset()
})

describe("OrgDetailsModal", () => {
  it("shows the display name, slug, id, plan, and owner role", () => {
    planDetails.mockReturnValue({
      data: { name: "Classroom 50 Summer Dev", plan: { name: "team" } },
    })
    render(<OrgDetailsModal summary={summary()} open onClose={() => {}} />)
    expect(
      screen.getAllByText("Classroom 50 Summer Dev").length,
    ).toBeGreaterThan(0)
    expect(screen.getByText("classroom50-summer-dev")).toBeTruthy()
    expect(screen.getByText("4242")).toBeTruthy()
    expect(screen.getByText("team")).toBeTruthy()
    expect(screen.getByText("orgs.detailsModal.roleAdmin")).toBeTruthy()
  })

  it("falls back to the slug when no display name is set", () => {
    planDetails.mockReturnValue({ data: { name: null } })
    render(<OrgDetailsModal summary={summary()} open onClose={() => {}} />)
    // Heading shows the slug; no separate display-name row label is rendered
    // (that row is omitted). The slug still appears as the Slug row value.
    expect(
      screen.getAllByText("classroom50-summer-dev").length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText("orgs.detailsModal.displayName")).toBeNull()
  })

  it("hides the Settings link for a non-owner member", () => {
    planDetails.mockReturnValue({ data: { name: "Acme" } })
    render(
      <OrgDetailsModal
        summary={summary({}, "member")}
        open
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText("orgs.detailsModal.linkSettings")).toBeNull()
    expect(screen.getByText("orgs.detailsModal.linkRepos")).toBeTruthy()
    expect(screen.getByText("orgs.detailsModal.roleMember")).toBeTruthy()
  })
})
