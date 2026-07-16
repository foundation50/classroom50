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

import { TemplateField } from "./TemplateField"
import type { StringField } from "./formFieldHelpers"

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
})

afterEach(() => cleanup())

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
    await screen.findByText("assignments.template.privateHasAccess_2", {
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
    await screen.findByText("assignments.template.okSuffix", { exact: false })
    expect(screen.queryByText(ACTION_KEY)).toBeNull()
  })

  it("hides the Fix button on the create form (no slug)", async () => {
    verifyTemplateAccess.mockResolvedValue(okInOrgPrivate)
    teamHasRepoAccess.mockResolvedValue(false)
    renderField({ slug: undefined })
    await screen.findByText("assignments.template.privateWillGrant_2", {
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
