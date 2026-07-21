// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import type { ReactNode } from "react"

import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import { __resetGitHubHealthForTest } from "@/lib/githubHealth/githubHealthStore"

// Capture the options (onError/onSuccess) the page passes to mutateAsync so a
// test can drive each callback directly, without a real GitHub client/mutation.
let lastMutateOptions: {
  onError?: (err: unknown) => void
  onSuccess?: (result: unknown, variables: unknown) => void
} | null = null
const mutateAsync = vi.fn(
  (_input: unknown, options?: typeof lastMutateOptions) => {
    lastMutateOptions = options ?? null
    return Promise.resolve()
  },
)
vi.mock("@/hooks/mutations/useCreateAssignment", () => ({
  useCreateAssignment: () => ({ isPending: false, mutateAsync }),
}))

// The health store fires a best-effort githubstatus.com probe once suspicion
// trips; stub it so these tests never hit the network.
vi.mock("@/lib/githubHealth/githubStatusApi", () => ({
  fetchGitHubStatusIndicator: () => Promise.resolve(null),
}))

// Stub the form to a single submit button that fires onSubmit with a minimal
// payload — the page's onError/onSuccess wiring is what's under test.
vi.mock("@/pages/assignments/CreateAssignmentForm", () => ({
  default: ({ onSubmit }: { onSubmit: (values: { slug: string }) => void }) => (
    <button type="button" onClick={() => onSubmit({ slug: "hw1" })}>
      submit
    </button>
  ),
}))

// Heavy layout/role boundaries the page mounts; stub to pass-through so the
// alert branch logic is what we exercise.
vi.mock("@/components/PageShell", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/PageHeader", () => ({ default: () => null }))
vi.mock("@/components/breadcrumb", () => ({ default: () => null }))
vi.mock("@/components/RequireRole", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/EmptyRosterNotice", () => ({
  EmptyRosterNotice: () => null,
}))

vi.mock("@/hooks/useDocumentTitle", () => ({
  useDocumentTitle: () => undefined,
}))
vi.mock("@/hooks/useGetClassAssignments", () => ({
  default: () => ({ data: { assignments: [] } }),
}))
vi.mock("@/hooks/useEmptyRosterWarning", () => ({
  default: () => ({ show: false, hasRosterRows: true }),
}))
vi.mock("@/hooks/useTrackPublishDeploy", () => ({
  useTrackPublishDeploy: () => vi.fn(),
}))
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify: vi.fn() }),
}))

const navigateMock = vi.fn()
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useParams: () => ({ org: "acme", classroom: "cs101" }),
  }
})

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

import CreateAssignmentPage from "./CreateAssignmentPage"

const noRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}
const apiError = (status: number, over: Partial<GitHubRateLimit> = {}) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: { ...noRateLimit, ...over },
  })

const STATUS_LINK = "githubStatus.checkStatusLink"

const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "submit" }))

const failWith = (err: unknown) => act(() => lastMutateOptions?.onError?.(err))
const succeedWith = (result: unknown) =>
  act(() => lastMutateOptions?.onSuccess?.(result, { slug: "hw1" }))

beforeEach(() => {
  mutateAsync.mockClear()
  lastMutateOptions = null
  navigateMock.mockClear()
  __resetGitHubHealthForTest()
  vi.stubGlobal("scrollTo", vi.fn())
})

afterEach(() => {
  cleanup()
  __resetGitHubHealthForTest()
  vi.unstubAllGlobals()
})

describe("CreateAssignmentPage outage save hint", () => {
  it("shows the githubstatus.com hint (not the raw message) on an outage-shaped save failure", () => {
    render(<CreateAssignmentPage />)
    submit()
    failWith(apiError(503))
    expect(screen.queryByText(STATUS_LINK)).not.toBeNull()
    // The raw error message is replaced by the outage note.
    expect(screen.queryByText("HTTP 503")).toBeNull()
  })

  it("shows the hint for a wrapped network failure", () => {
    render(<CreateAssignmentPage />)
    submit()
    failWith(new TypeError("Failed to fetch"))
    expect(screen.queryByText(STATUS_LINK)).not.toBeNull()
  })

  it("shows the raw message and no hint on a definitive 4xx", () => {
    render(<CreateAssignmentPage />)
    submit()
    failWith(apiError(404))
    expect(screen.queryByText(STATUS_LINK)).toBeNull()
    expect(screen.queryByText("HTTP 404")).not.toBeNull()
  })

  it("shows the raw message and no hint on a rate limit", () => {
    render(<CreateAssignmentPage />)
    submit()
    failWith(apiError(429))
    expect(screen.queryByText(STATUS_LINK)).toBeNull()
    expect(screen.queryByText("HTTP 429")).not.toBeNull()
  })

  it("does not treat a non-network local error as an outage", () => {
    render(<CreateAssignmentPage />)
    submit()
    failWith(new Error("something local broke"))
    expect(screen.queryByText(STATUS_LINK)).toBeNull()
    expect(screen.queryByText("something local broke")).not.toBeNull()
  })

  it("clears the outage hint when a resubmit fails with a definitive error", () => {
    render(<CreateAssignmentPage />)
    submit()
    failWith(apiError(503))
    expect(screen.queryByText(STATUS_LINK)).not.toBeNull()

    // Resubmit (onSubmit resets outageError) then fail definitively.
    submit()
    failWith(apiError(404))
    expect(screen.queryByText(STATUS_LINK)).toBeNull()
    expect(screen.queryByText("HTTP 404")).not.toBeNull()
  })
})

describe("CreateAssignmentPage templateGrantWarning surfacing", () => {
  const WARNING =
    "needs the classroom50-cs101 team granted read — an organization owner"

  it("renders the warning and stays on the page (no navigate) when the grant is skipped", () => {
    render(<CreateAssignmentPage />)
    submit()
    succeedWith({ newCommitSha: "sha", templateGrantWarning: WARNING })
    expect(screen.queryByText(WARNING)).not.toBeNull()
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it("navigates and shows no warning on a clean save", () => {
    render(<CreateAssignmentPage />)
    submit()
    succeedWith({ newCommitSha: "sha" })
    expect(screen.queryByText(WARNING)).toBeNull()
    expect(navigateMock).toHaveBeenCalled()
  })
})
