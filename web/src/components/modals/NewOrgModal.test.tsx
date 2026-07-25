// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { Classroom50OrgSummary } from "@/github-core/queries"
import type { NeedsSetupPlans } from "@/hooks/useNeedsSetupPlans"

// Count-aware t() so the pluralized pickPrompt (_one/_other + {{count}}) is
// actually exercised rather than collapsed to the raw key.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { count?: number }) => {
        if (key === "orgs.newOrg.pickPrompt" && opts?.count !== undefined) {
          const suffix = opts.count === 1 ? "_one" : "_other"
          return `${key}${suffix}:${opts.count}`
        }
        return key
      },
    }),
  }
})

const navigate = vi.fn()
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return { ...actual, useNavigate: () => navigate }
})

let plansResult: NeedsSetupPlans = { byLogin: {}, pending: new Set() }
vi.mock("@/hooks/useNeedsSetupPlans", () => ({
  default: () => plansResult,
}))

// MissingOrgNotice (rendered inside the modal) offers re-authorization, and
// useGithubAuth throws outside its provider.
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ startWebFlow: vi.fn() }),
}))

import NewOrgModal from "./NewOrgModal"

const summary = (
  login: string,
  over: Partial<Classroom50OrgSummary["org"]> = {},
): Classroom50OrgSummary =>
  ({
    org: {
      login,
      id: login.length + login.charCodeAt(0),
      avatar_url: "https://x/avatar.png",
      description: null,
      html_url: `https://github.com/${login}`,
      ...over,
    },
    membership: { state: "active", role: "admin" },
    classroom50: {
      status: "needs_setup",
      canAccessRepo: false,
      canInitialize: true,
      pagesUrl: "",
    },
  }) as Classroom50OrgSummary

function renderModal(orgs: Classroom50OrgSummary[]) {
  return render(
    <NewOrgModal
      open
      needsSetupOrgs={orgs}
      refreshing={false}
      onRefresh={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}

// Row order as rendered, so sort assertions don't depend on the input order.
const orgOrder = () =>
  Array.from(document.querySelectorAll("li button > span > span:first-child"))
    .map((el) => el.textContent)
    .filter((text): text is string => Boolean(text))

beforeEach(() => {
  navigate.mockReset()
  plansResult = { byLogin: {}, pending: new Set() }
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("NewOrgModal", () => {
  it("routes a supported (paid) org into the setup wizard", () => {
    plansResult = { byLogin: { acme: "team" }, pending: new Set() }
    renderModal([summary("acme")])

    expect(screen.getByText("orgs.newOrg.setUp")).toBeTruthy()
    fireEvent.click(screen.getByText("acme"))
    expect(navigate).toHaveBeenCalledWith({
      to: "/$org/setup",
      params: { org: "acme" },
    })
  })

  it("opens the Free-plan explainer instead of routing for a free org", () => {
    plansResult = { byLogin: { acme: "free" }, pending: new Set() }
    renderModal([summary("acme")])

    expect(screen.getByText("orgs.newOrg.notSupportedBadge")).toBeTruthy()
    expect(screen.getByText("orgs.newOrg.details")).toBeTruthy()

    fireEvent.click(screen.getByText("acme"))
    expect(navigate).not.toHaveBeenCalled()
    // The explainer content is now shown.
    expect(screen.getByText("orgs.newOrg.freePlanInfo.title")).toBeTruthy()
  })

  it("disables a row and shows a spinner while its plan is still loading", () => {
    plansResult = { byLogin: {}, pending: new Set(["acme"]) }
    renderModal([summary("acme")])

    const row = screen.getByText("acme").closest("button")
    expect(row?.disabled).toBe(true)
    // Neither the Set up affordance nor the Not-supported badge shows yet.
    expect(screen.queryByText("orgs.newOrg.setUp")).toBeNull()
    expect(screen.queryByText("orgs.newOrg.notSupportedBadge")).toBeNull()

    fireEvent.click(screen.getByText("acme"))
    expect(navigate).not.toHaveBeenCalled()
  })

  it("shows a pluralized count in the heading", () => {
    plansResult = {
      byLogin: { a: "team", b: "team" },
      pending: new Set(),
    }
    const { rerender } = renderModal([summary("a"), summary("b")])
    expect(screen.getByText("orgs.newOrg.pickPrompt_other:2")).toBeTruthy()

    plansResult = { byLogin: { a: "team" }, pending: new Set() }
    rerender(
      <NewOrgModal
        open
        needsSetupOrgs={[summary("a")]}
        refreshing={false}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText("orgs.newOrg.pickPrompt_one:1")).toBeTruthy()
  })

  it("renders the missing-org notice inside the modal", () => {
    plansResult = { byLogin: { acme: "team" }, pending: new Set() }
    renderModal([summary("acme")])
    expect(screen.getByText("orgs.missingNotice.title")).toBeTruthy()
  })

  it("shows the all-set-up copy and the notice when there are no orgs", () => {
    renderModal([])
    expect(screen.getByText("orgs.newOrg.allSetUp")).toBeTruthy()
    expect(screen.getByText("orgs.missingNotice.title")).toBeTruthy()
  })

  it("refreshes from the list header, outside the notice disclosure", () => {
    const onRefresh = vi.fn()
    plansResult = { byLogin: { acme: "team" }, pending: new Set() }
    render(
      <NewOrgModal
        open
        needsSetupOrgs={[summary("acme")]}
        refreshing={false}
        onRefresh={onRefresh}
        onClose={vi.fn()}
      />,
    )

    const refresh = screen.getByText("orgs.newOrg.refresh")
    // Must sit beside the list heading, not inside the collapsible notice —
    // otherwise it reads as the fix for a missing org and can be hidden.
    expect(refresh.closest("details")).toBeNull()
    fireEvent.click(refresh)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("mounts the notice only while open, so defaultOpen sees the loaded list", () => {
    plansResult = { byLogin: { acme: "team" }, pending: new Set() }
    const { rerender } = render(
      <NewOrgModal
        open={false}
        needsSetupOrgs={[]}
        refreshing={false}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // Modal renders children regardless of `open`, so without the guard the
    // notice would latch defaultOpen from the pre-load empty list.
    expect(screen.queryByText("orgs.missingNotice.title")).toBeNull()

    rerender(
      <NewOrgModal
        open
        needsSetupOrgs={[summary("acme")]}
        refreshing={false}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText("orgs.missingNotice.title")).toBeTruthy()
    expect(document.querySelector("details")?.open).toBe(false)
  })

  it("sorts by login, since GitHub's membership order is arbitrary", () => {
    plansResult = {
      byLogin: { zeta: "team", alpha: "team", mid: "team" },
      pending: new Set(),
    }
    renderModal([summary("zeta"), summary("alpha"), summary("mid")])

    expect(orgOrder()).toEqual(["alpha", "mid", "zeta"])
    expect(screen.queryByText("orgs.newOrg.newBadge")).toBeNull()
  })

  it("floats an org that appears after opening to the top, badged New", () => {
    plansResult = {
      byLogin: { alpha: "team", zeta: "team" },
      pending: new Set(),
    }
    const { rerender } = renderModal([summary("alpha")])
    expect(orgOrder()).toEqual(["alpha"])

    // The grant-page return refreshes the list mid-open; zeta wasn't in the
    // snapshot taken when the modal mounted, so it's the just-granted one.
    rerender(
      <NewOrgModal
        open
        needsSetupOrgs={[summary("alpha"), summary("zeta")]}
        refreshing={false}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(orgOrder()).toEqual(["zeta", "alpha"])
    expect(screen.getAllByText("orgs.newOrg.newBadge")).toHaveLength(1)
  })

  it("badges nothing when the list was empty on open", () => {
    // No baseline to contrast against — every org would otherwise look new.
    const { rerender } = renderModal([])
    plansResult = {
      byLogin: { alpha: "team", zeta: "team" },
      pending: new Set(),
    }
    rerender(
      <NewOrgModal
        open
        needsSetupOrgs={[summary("zeta"), summary("alpha")]}
        refreshing={false}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(orgOrder()).toEqual(["alpha", "zeta"])
    expect(screen.queryByText("orgs.newOrg.newBadge")).toBeNull()
  })

  it("resets the New baseline when the modal is reopened", () => {
    plansResult = {
      byLogin: { alpha: "team", zeta: "team" },
      pending: new Set(),
    }
    const orgs = [summary("alpha"), summary("zeta")]
    const { rerender } = renderModal([summary("alpha")])
    rerender(
      <NewOrgModal
        open
        needsSetupOrgs={orgs}
        refreshing={false}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getAllByText("orgs.newOrg.newBadge")).toHaveLength(1)

    const reopen = (open: boolean) =>
      rerender(
        <NewOrgModal
          open={open}
          needsSetupOrgs={orgs}
          refreshing={false}
          onRefresh={vi.fn()}
          onClose={vi.fn()}
        />,
      )
    reopen(false)
    reopen(true)

    expect(screen.queryByText("orgs.newOrg.newBadge")).toBeNull()
    expect(orgOrder()).toEqual(["alpha", "zeta"])
  })
})
