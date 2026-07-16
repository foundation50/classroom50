// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import type { Assignment } from "@/types/classroom"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

let orgRole = "owner"
vi.mock("@/context/githubOrgRole/GitHubOrgRoleProvider", () => ({
  useGitHubOrgRole: () => ({ githubOrgRole: orgRole }),
}))

const notify = vi.fn()
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify, dismiss: vi.fn() }),
}))

const listRepoTeams = vi.fn()
vi.mock("@/github-core/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/github-core/queries")>()
  return {
    ...actual,
    repoTeamsQuery: (_client: unknown, owner: string, repo: string) => ({
      queryKey: ["github", "repo-teams", owner, repo],
      queryFn: () => listRepoTeams(owner, repo),
      enabled: Boolean(owner && repo),
    }),
  }
})

const reconcileMutate = vi.fn()
let reconcilePending = false
vi.mock("@/hooks/mutations/useReconcileTemplateAccess", () => ({
  useReconcileTemplateAccess: () => ({
    mutate: reconcileMutate,
    isPending: reconcilePending,
  }),
}))

import { TemplateAccessModal } from "./TemplateAccessModal"

const ORG = "acme"
const template = { owner: ORG, repo: "tmpl", branch: "main" }
const assignment = (over: Partial<Assignment> = {}): Assignment =>
  ({
    slug: "hw1",
    name: "HW 1",
    mode: "individual",
    template,
    ...over,
  }) as Assignment

function renderModal() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client }, children)
  return render(
    createElement(TemplateAccessModal, {
      org: ORG,
      classroom: "cs101",
      assignment: assignment(),
      onClose: vi.fn(),
    }),
    { wrapper },
  )
}

const FIX_ACTION = "assignments.template.accessModal.fixAction"
const OWNER_NOTE = "assignments.template.accessModal.ownerOnlyNote"

beforeEach(() => {
  orgRole = "owner"
  reconcilePending = false
  listRepoTeams.mockReset()
  listRepoTeams.mockResolvedValue([])
  reconcileMutate.mockReset()
  notify.mockReset()
})

afterEach(cleanup)

describe("TemplateAccessModal", () => {
  it("shows the template owner/repo and a GitHub link", async () => {
    renderModal()
    expect(screen.getByText("acme/tmpl")).toBeTruthy()
    expect(
      screen.getByText("assignments.template.accessModal.openOnGitHub"),
    ).toBeTruthy()
  })

  it("lists the teams that have access", async () => {
    listRepoTeams.mockResolvedValue([
      {
        id: 1,
        name: "cs101 students",
        slug: "classroom50-cs101",
        html_url: "https://x",
        permission: "pull",
      },
    ])
    renderModal()
    expect(await screen.findByText("cs101 students")).toBeTruthy()
  })

  it("shows the empty state when no team has access", async () => {
    listRepoTeams.mockResolvedValue([])
    renderModal()
    expect(
      await screen.findByText("assignments.template.accessModal.teamsEmpty"),
    ).toBeTruthy()
  })

  it("shows the visibility caveat (not 'empty') for a non-owner with no visible teams", async () => {
    orgRole = "member"
    listRepoTeams.mockResolvedValue([])
    renderModal()
    expect(
      await screen.findByText(
        "assignments.template.accessModal.teamsUnavailable",
      ),
    ).toBeTruthy()
    expect(
      screen.queryByText("assignments.template.accessModal.teamsEmpty"),
    ).toBeNull()
  })

  it("shows the fix action to an org owner", () => {
    orgRole = "owner"
    renderModal()
    expect(screen.queryByText(FIX_ACTION)).toBeTruthy()
    expect(screen.queryByText(OWNER_NOTE)).toBeNull()
  })

  it("hides the fix action from a non-owner and shows the owner-only note", () => {
    orgRole = "member"
    renderModal()
    expect(screen.queryByText(FIX_ACTION)).toBeNull()
    expect(screen.queryByText(OWNER_NOTE)).toBeTruthy()
  })

  it("invokes the reconcile hook when the owner clicks fix", () => {
    orgRole = "owner"
    renderModal()
    fireEvent.click(screen.getByText(FIX_ACTION))
    expect(reconcileMutate).toHaveBeenCalledWith(
      { org: ORG, classroom: "cs101", slug: "hw1", template },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    )
  })

  it("toasts success and disables fix after a clean grant (no re-flash)", async () => {
    orgRole = "owner"
    // Student team absent, so Fix starts enabled.
    listRepoTeams.mockResolvedValue([])
    renderModal()
    await waitFor(() =>
      expect(screen.getByText(FIX_ACTION).closest("button")?.disabled).toBe(
        false,
      ),
    )

    fireEvent.click(screen.getByText(FIX_ACTION))
    const onSuccess = reconcileMutate.mock.calls[0][1].onSuccess
    act(() => onSuccess({ warning: undefined }))

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success" }),
    )
    // Even though the eventually-consistent list is still empty, the button
    // stays disabled and the empty state is suppressed — no post-success
    // re-flash / re-enable.
    await waitFor(() =>
      expect(screen.getByText(FIX_ACTION).closest("button")?.disabled).toBe(
        true,
      ),
    )
    expect(
      screen.queryByText("assignments.template.accessModal.teamsEmpty"),
    ).toBeNull()
  })

  it("toasts the warning and keeps fix enabled when the grant fails", async () => {
    orgRole = "owner"
    listRepoTeams.mockResolvedValue([])
    renderModal()
    await waitFor(() =>
      expect(screen.getByText(FIX_ACTION).closest("button")?.disabled).toBe(
        false,
      ),
    )

    fireEvent.click(screen.getByText(FIX_ACTION))
    const onSuccess = reconcileMutate.mock.calls[0][1].onSuccess
    act(() => onSuccess({ warning: "student grant failed" }))

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error" }),
    )
    // A failed grant must not latch "satisfied" — the owner can retry.
    expect(screen.getByText(FIX_ACTION).closest("button")?.disabled).toBe(false)
  })

  it("enables fix when the classroom student team is missing", async () => {
    orgRole = "owner"
    // Only an unrelated team has access — the student team is absent.
    listRepoTeams.mockResolvedValue([
      {
        id: 3,
        name: "other",
        slug: "some-other-team",
        html_url: "https://x",
        permission: "pull",
      },
    ])
    renderModal()
    await waitFor(() =>
      expect(screen.getByText(FIX_ACTION).closest("button")?.disabled).toBe(
        false,
      ),
    )
  })

  it("disables fix once the classroom student team already has access", async () => {
    orgRole = "owner"
    listRepoTeams.mockResolvedValue([
      {
        id: 1,
        name: "cs101 students",
        slug: "classroom50-cs101",
        html_url: "https://x",
        permission: "pull",
      },
    ])
    renderModal()
    await waitFor(() =>
      expect(screen.getByText(FIX_ACTION).closest("button")?.disabled).toBe(
        true,
      ),
    )
  })

  it("does not offer the fix action for an out-of-org template", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    render(
      createElement(TemplateAccessModal, {
        org: ORG,
        classroom: "cs101",
        assignment: assignment({
          template: { owner: "other", repo: "tmpl", branch: "main" },
        }),
        onClose: vi.fn(),
      }),
      {
        wrapper: ({ children }: PropsWithChildren) =>
          createElement(QueryClientProvider, { client }, children),
      },
    )
    expect(screen.queryByText(FIX_ACTION)).toBeNull()
    expect(screen.queryByText(OWNER_NOTE)).toBeNull()
  })
})
