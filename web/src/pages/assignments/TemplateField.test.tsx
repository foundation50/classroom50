// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
    // Render a <Trans> as its key so verdict assertions can target the merged
    // key names without initializing a real i18next instance.
    Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  }
})

const verifyTemplateAccess = vi.fn()
vi.mock("@/domain/assignments", () => ({
  verifyTemplateAccess: (...a: unknown[]) => verifyTemplateAccess(...a),
}))

const teamHasRepoAccess = vi.fn()
vi.mock("@/github-core/queries", () => ({
  teamHasRepoAccess: (...a: unknown[]) => teamHasRepoAccess(...a),
}))

vi.mock("@/context/github/GitHubProvider", () => ({
  useOptionalGitHubClient: () => ({ request: vi.fn() }),
}))
// The "Fix template access" recovery is owner-only (addRepositoryToTeam). Default
// the viewer to an org owner so the inline-Fix tests exercise the offered path;
// a non-owner case is covered by the dedicated test below.
let mockIsOwner = true
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useIsOrgOwner: () => ({
    isOwner: mockIsOwner,
    isPending: false,
    isError: false,
    retry: vi.fn(),
  }),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({ user: { login: "teacher" }, isLoadingUser: false }),
}))

const reconcileMutate = vi.fn()
let reconcilePending = false
vi.mock("@/hooks/mutations/useReconcileTemplateAccess", () => ({
  useReconcileTemplateAccess: () => ({
    mutate: reconcileMutate,
    isPending: reconcilePending,
  }),
}))

// The health store fires a best-effort githubstatus.com probe once suspicion
// trips; stub it so these tests never hit the network.
vi.mock("@/lib/githubHealth/githubStatusApi", () => ({
  fetchGitHubStatusIndicator: () => Promise.resolve(null),
}))

import { TemplateField } from "./TemplateField"
import type { StringField } from "./formFieldHelpers"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import {
  __resetGitHubHealthForTest,
  recordGitHubFailure,
} from "@/lib/githubHealth/githubHealthStore"

const ORG = "cs50"
const CLASSROOM = "cs50"
const SLUG = "hw1"

function fakeField(value: string): StringField {
  return {
    name: "template_repo",
    state: { value },
    handleChange: vi.fn(),
    handleBlur: vi.fn(),
  } as unknown as StringField
}

function renderField(props: Partial<Parameters<typeof TemplateField>[0]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return render(
    createElement(TemplateField, {
      field: fakeField("tmpl"),
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      ...props,
    }),
    { wrapper },
  )
}

const ACTION_KEY = "assignments.template.reconcile.action"

beforeEach(() => {
  verifyTemplateAccess.mockReset()
  teamHasRepoAccess.mockReset()
  reconcileMutate.mockReset()
  reconcilePending = false
  mockIsOwner = true
  __resetGitHubHealthForTest()
})

afterEach(() => {
  cleanup()
  __resetGitHubHealthForTest()
})

describe("TemplateField — inline Fix template access", () => {
  const okInOrgPrivate = {
    kind: "ok",
    owner: ORG,
    repo: "tmpl",
    branch: "main",
    visibility: "private",
    inOrg: true,
  }

  it("shows the Fix button for an in-org private template the team lacks", async () => {
    verifyTemplateAccess.mockResolvedValue(okInOrgPrivate)
    teamHasRepoAccess.mockResolvedValue(false)
    renderField()
    expect(await screen.findByText(ACTION_KEY)).toBeTruthy()
  })

  it("hides the Fix button when the team already has access", async () => {
    verifyTemplateAccess.mockResolvedValue(okInOrgPrivate)
    teamHasRepoAccess.mockResolvedValue(true)
    renderField()
    // The has-access verdict renders; the fix action must not.
    await screen.findByText("assignments.template.privateHasAccess", {
      exact: false,
    })
    expect(screen.queryByText(ACTION_KEY)).toBeNull()
  })

  it("hides the Fix button for a public template", async () => {
    verifyTemplateAccess.mockResolvedValue({
      kind: "ok",
      owner: ORG,
      repo: "tmpl",
      branch: "main",
      visibility: "public",
      inOrg: true,
    })
    renderField()
    await screen.findByText("assignments.template.okPublicInOrg", {
      exact: false,
    })
    expect(screen.queryByText(ACTION_KEY)).toBeNull()
  })

  it("hides the Fix button on the create form (no slug)", async () => {
    verifyTemplateAccess.mockResolvedValue(okInOrgPrivate)
    teamHasRepoAccess.mockResolvedValue(false)
    renderField({ slug: undefined })
    await screen.findByText("assignments.template.privateWillGrant", {
      exact: false,
    })
    expect(screen.queryByText(ACTION_KEY)).toBeNull()
  })

  it("hides the Fix button for a non-owner (the grant is owner-only)", async () => {
    // A head-TA authoring can set a template but can't grant team read
    // (addRepositoryToTeam is org-owner-only), so the recovery must not show.
    mockIsOwner = false
    verifyTemplateAccess.mockResolvedValue(okInOrgPrivate)
    teamHasRepoAccess.mockResolvedValue(false)
    renderField()
    // Wait for verification to settle, then assert the fix action is absent.
    await screen.findByText("assignments.template.privateWillGrant", {
      exact: false,
    })
    expect(screen.queryByText(ACTION_KEY)).toBeNull()
  })

  it("invokes the reconcile hook with the resolved target on click", async () => {
    verifyTemplateAccess.mockResolvedValue(okInOrgPrivate)
    teamHasRepoAccess.mockResolvedValue(false)
    renderField()
    fireEvent.click(await screen.findByText(ACTION_KEY))
    expect(reconcileMutate).toHaveBeenCalledWith(
      {
        org: ORG,
        classroom: CLASSROOM,
        slug: SLUG,
        template: { owner: ORG, repo: "tmpl", branch: "main" },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    )
  })

  it("renders the inline warning when the grant reports a failure", async () => {
    verifyTemplateAccess.mockResolvedValue(okInOrgPrivate)
    teamHasRepoAccess.mockResolvedValue(false)
    renderField()
    fireEvent.click(await screen.findByText(ACTION_KEY))
    const onSuccess = reconcileMutate.mock.calls[0][1].onSuccess
    act(() => onSuccess({ warning: "student grant failed" }))
    expect(
      screen.getByText("assignments.template.reconcile.failed", {
        exact: false,
      }).textContent,
    ).toContain("student grant failed")
  })

  it("shows no inline warning on a clean grant", async () => {
    verifyTemplateAccess.mockResolvedValue(okInOrgPrivate)
    teamHasRepoAccess.mockResolvedValue(false)
    renderField()
    fireEvent.click(await screen.findByText(ACTION_KEY))
    const onSuccess = reconcileMutate.mock.calls[0][1].onSuccess
    act(() => onSuccess({ warning: undefined }))
    expect(
      screen.queryByText("assignments.template.reconcile.failed", {
        exact: false,
      }),
    ).toBeNull()
  })
})

describe("TemplateField — outage hint on inconclusive verdicts", () => {
  const noRateLimit: GitHubRateLimit = {
    limit: null,
    remaining: null,
    used: null,
    reset: null,
    resource: null,
    retryAfter: null,
  }
  const apiError = (status: number) =>
    new GitHubAPIError({
      status,
      url: "https://api.github.com/x",
      message: `HTTP ${status}`,
      body: null,
      rateLimit: noRateLimit,
    })

  function suspectOutage() {
    const base = Date.now()
    recordGitHubFailure(apiError(500), base)
    recordGitHubFailure(apiError(500), base + 100)
    recordGitHubFailure(apiError(500), base + 200)
  }

  const STATUS_LINK = "githubStatus.checkStatusLink"

  it("shows the githubstatus.com hint on an 'unknown' verdict when an outage is suspected", async () => {
    verifyTemplateAccess.mockResolvedValue({
      kind: "unknown",
      owner: ORG,
      repo: "tmpl",
      outage: false,
    })
    act(() => suspectOutage())
    renderField()
    expect(await screen.findByText(STATUS_LINK)).toBeTruthy()
    // The local verdict copy still renders alongside the hint.
    expect(screen.getByText("assignments.template.unknown")).toBeTruthy()
  })

  it("shows the hint on an 'unknown' verdict flagged as an outage, even with no global suspicion", async () => {
    // The verify query resolves-successfully with this verdict, which clears the
    // global suspicion — so a verify that itself failed with a 5xx/network error
    // must still surface the hint via the verdict's own `outage` flag.
    verifyTemplateAccess.mockResolvedValue({
      kind: "unknown",
      owner: ORG,
      repo: "tmpl",
      outage: true,
    })
    renderField()
    expect(await screen.findByText(STATUS_LINK)).toBeTruthy()
    expect(screen.getByText("assignments.template.unknown")).toBeTruthy()
  })

  it("does NOT show the hint on an 'unknown' verdict with no outage and no suspicion", async () => {
    verifyTemplateAccess.mockResolvedValue({
      kind: "unknown",
      owner: ORG,
      repo: "tmpl",
      outage: false,
    })
    renderField()
    await screen.findByText("assignments.template.unknown")
    expect(screen.queryByText(STATUS_LINK)).toBeNull()
  })

  it("shows the hint on a 'rate-limited' verdict when an outage is suspected", async () => {
    verifyTemplateAccess.mockResolvedValue({
      kind: "rate-limited",
      owner: ORG,
      repo: "tmpl",
      outage: false,
    })
    act(() => suspectOutage())
    renderField()
    expect(await screen.findByText(STATUS_LINK)).toBeTruthy()
  })

  it("does NOT show the hint on a definitive verdict even when suspected", async () => {
    verifyTemplateAccess.mockResolvedValue({
      kind: "not-template",
      owner: ORG,
      repo: "tmpl",
    })
    act(() => suspectOutage())
    renderField()
    await screen.findByText("assignments.template.notTemplate", {
      exact: false,
    })
    expect(screen.queryByText(STATUS_LINK)).toBeNull()
  })
})
