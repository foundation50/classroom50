// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactElement } from "react"

// Wired-path coverage for the paused-org Feedback PR warning. The unit tests
// prove the verdict and the notice in isolation; this proves the notice actually
// reaches the assignment form. It matters because EVERY failure mode of this
// feature is silence — a provider mounted in the wrong place, a subject object
// assembled wrong, or a gate that never opens all look identical to "working"
// in a green suite.

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

// TemplateField needs a GitHubAuthProvider and is irrelevant here.
vi.mock("./TemplateField", () => ({
  TemplateField: () => null,
}))

// Real i18n: the warning copy is the deliverable, and <Trans> renders nothing
// under a stubbed useTranslation.
import "@/i18n"
import CreateAssignmentForm from "./CreateAssignmentForm"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const OWNER = {
  isOwner: true,
  isPending: false,
  isError: false,
  retry: () => {},
}
const NON_OWNER = {
  isOwner: false,
  isPending: false,
  isError: false,
  retry: () => {},
}

const renderForm = (ui: ReactElement) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>,
  )

const PAUSED_COPY = /Autograding is paused/

const asViewer = (owner: typeof OWNER, mode: string) => {
  isOrgOwner.mockReturnValue(owner)
  getOrgActionsMode.mockResolvedValue(mode)
}

describe("Feedback PR warning on the assignment form", () => {
  it("warns beside the toggle when the org is paused", async () => {
    asViewer(OWNER, "paused")

    renderForm(<CreateAssignmentForm org="acme" onSubmit={() => {}} />)

    // feedback_pr defaults ON at create, so the warning applies immediately.
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(PAUSED_COPY)
  })

  it("stays silent when autograding is active", async () => {
    asViewer(OWNER, "active")

    renderForm(<CreateAssignmentForm org="acme" onSubmit={() => {}} />)

    await waitFor(() => expect(getOrgActionsMode).toHaveBeenCalled())
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("stays silent for a non-owner author even when paused", async () => {
    asViewer(NON_OWNER, "paused")

    renderForm(<CreateAssignmentForm org="acme" onSubmit={() => {}} />)

    // Documents the accepted limitation: the Actions-permissions read is
    // admin-only, so team-based teachers and head-TAs get no signal.
    expect(getOrgActionsMode).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  // The form must also render where GitHub auth isn't ready — an advisory
  // warning must never break the surface it annotates.
  it("renders the form without an org and stays silent", () => {
    asViewer(OWNER, "paused")

    renderForm(<CreateAssignmentForm onSubmit={() => {}} />)

    expect(getOrgActionsMode).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  // The pause is transient, so the manifest flag must stay settable — unlike the
  // empty_repo case, which locks the toggle off structurally.
  it("leaves the toggle operable while blocked, and drops the warning when opted out", async () => {
    const user = userEvent.setup()
    asViewer(OWNER, "paused")

    const { container } = renderForm(
      <CreateAssignmentForm org="acme" onSubmit={() => {}} />,
    )

    const toggle = container.querySelector<HTMLInputElement>("#feedback_pr")
    expect(toggle).not.toBeNull()
    expect(toggle?.disabled).toBe(false)
    expect(toggle?.checked).toBe(true)
    expect((await screen.findByRole("alert")).textContent).toMatch(PAUSED_COPY)

    // Turning the feature off removes the warning: it is about this
    // assignment's opt-in, not the org in the abstract.
    await user.click(toggle!)
    expect(toggle?.checked).toBe(false)
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
