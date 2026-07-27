// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// Override only useTranslation so assertions can match on stable i18n keys
// rather than English copy; keep the rest (initReactI18next, etc.) real so the
// module's transitive i18n setup still loads.
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

import { ConcernRow } from "./OrgPolicyAuditPane"
import {
  classifyRepairOutcome,
  CONCERN_STATE_BADGE,
} from "./OrgPolicyAuditPane"
import type { ConcernCheck } from "@/orgPolicy/audit"

afterEach(cleanup)

const drifted: ConcernCheck = {
  id: "branchProtection",
  title: "Branch protection",
  verdict: { state: "unenforced" },
  settingsUrl: "https://github.com/acme/classroom50/settings/branches",
}

const noop = () => {}

describe("ConcernRow", () => {
  it("offers Fix it for a drifted, fixable concern with no unresolved outcome", () => {
    render(<ConcernRow concern={drifted} canFix fixing={false} onFix={noop} />)
    expect(screen.getByText("orgSettings.audit.fixIt")).not.toBeNull()
    expect(screen.queryByText("orgSettings.audit.needsManualSetup")).toBeNull()
  })

  it("hides Fix it and shows the manual-setup state when unresolved", () => {
    render(
      <ConcernRow
        concern={drifted}
        canFix
        fixing={false}
        onFix={noop}
        unresolvedMessage="acme/classroom50: branch protection could not be applied…"
      />,
    )
    expect(screen.queryByText("orgSettings.audit.fixIt")).toBeNull()
    expect(
      screen.getByText("orgSettings.audit.needsManualSetup"),
    ).not.toBeNull()
    // Cause-neutral explanation is shown.
    expect(
      screen.getByText("orgSettings.audit.couldntAutoConfigure"),
    ).not.toBeNull()
    // The manual settings link is still available.
    const link = screen.getByText("orgSettings.audit.viewOnGitHub").closest("a")
    expect(link?.getAttribute("href")).toBe(drifted.settingsUrl)
  })

  it("renders a translated detail descriptor via its i18n key", () => {
    const unreadable: ConcernCheck = {
      id: "orgBudget",
      title: "Actions spending cap",
      verdict: {
        state: "unreadable",
        detail: {
          key: "orgSettings.audit.detail.budgetUnreadable",
          params: { reason: "400" },
        },
      },
      settingsUrl:
        "https://github.com/organizations/acme/settings/billing/budgets",
    }
    render(
      <ConcernRow concern={unreadable} canFix fixing={false} onFix={noop} />,
    )
    // The raw descriptor is never rendered; the key is (t() passes it through
    // in this test's mock), proving detail goes through translation.
    expect(
      screen.getByText("orgSettings.audit.detail.budgetUnreadable"),
    ).not.toBeNull()
  })
  it("shows a paused concern as paused, with no Fix it button", () => {
    const paused: ConcernCheck = {
      id: "orgActions",
      title: "Actions permissions",
      verdict: {
        state: "paused",
        detail: { key: "orgSettings.audit.detail.orgActionsPaused" },
      },
      settingsUrl: "https://github.com/organizations/acme/settings/actions",
    }
    render(<ConcernRow concern={paused} canFix fixing={false} onFix={noop} />)
    expect(screen.getByText("orgSettings.audit.statePaused")).not.toBeNull()
    expect(screen.queryByText("orgSettings.audit.fixIt")).toBeNull()
  })
})

describe("CONCERN_STATE_BADGE", () => {
  it("renders an unreadable concern with a warning, non-ghost badge", () => {
    // A ghost badge would ignore the tone and render neutral-grey (Badge.tsx),
    // silently swallowing the warning intent — guard against that regression.
    expect(CONCERN_STATE_BADGE.unreadable).toEqual({ tone: "warning" })
  })

  it("renders a paused concern amber, matching the autograding-paused badge", () => {
    expect(CONCERN_STATE_BADGE.paused).toEqual({ tone: "warning" })
  })
})

describe("classifyRepairOutcome", () => {
  it("persists a non-transient unresolved concern and shows no retry notice", () => {
    const outcome = classifyRepairOutcome({
      unfixableFields: [],
      unresolved: {
        message: "branch protection could not be applied",
        transient: false,
      },
    })
    expect(outcome.unresolvedConcern).toBe(
      "branch protection could not be applied",
    )
    expect(outcome.transientNotice).toBe(false)
  })

  it("does NOT persist a transient failure and shows the retry notice (R5)", () => {
    const outcome = classifyRepairOutcome({
      unfixableFields: [],
      unresolved: { message: "repo still initializing", transient: true },
    })
    // Transient -> retryable: never recorded as a manual-setup concern.
    expect(outcome.unresolvedConcern).toBeNull()
    expect(outcome.transientNotice).toBe(true)
  })

  it("carries orgDefaults pinned fields through unchanged", () => {
    const outcome = classifyRepairOutcome({
      unfixableFields: ["members_can_create_pages"],
    })
    expect(outcome.pinnedFields).toEqual(["members_can_create_pages"])
    expect(outcome.unresolvedConcern).toBeNull()
    expect(outcome.transientNotice).toBe(false)
  })

  it("a clean success yields no pins, no concern, no notice", () => {
    const outcome = classifyRepairOutcome({ unfixableFields: [] })
    expect(outcome.pinnedFields).toEqual([])
    expect(outcome.unresolvedConcern).toBeNull()
    expect(outcome.transientNotice).toBe(false)
  })
})
