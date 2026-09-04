// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { GitHubRepo } from "@/github-core/types"

const acceptAssignment = vi.fn()

const pagesAssignmentsSpy =
  vi.fn<(org?: string, classroom?: string, secret?: string) => void>()
const searchParams: { k?: string } = { k: "test-secret" }
let studentClassroomsData: Array<{ classroom: string; secret?: string }> = []
// Enrollment-gate inputs, reset per test. Default: active member, enrolled.
let orgRole = "member"
let enrollmentVerdict: "enrolled" | "not-enrolled" | "unresolved" = "enrolled"
// Whether the fetched assignment is closed to new submissions, reset per test.
let assignmentClosed = false
// Whether the fetched assignment is an empty_repo one (never writes the setup
// marker), reset per test.
let assignmentEmptyRepo = false
// The repo useGetRepo returns (null = the student hasn't accepted yet), reset
// per test. Set to acceptedRepo to model an already-accepted student.
let existingRepo: GitHubRepo | null = null
// The marker probe's verdict for an existing repo, reset per test. "incomplete"
// models the issue #502 shape: repo created, setup commit never landed. The
// spy records the hook's arguments so a test can assert on its `enabled` gate.
let repoSetupState: "unknown" | "complete" | "incomplete" = "complete"
const repoSetupRefetch = vi.fn()
const repoSetupSpy = vi.fn()

vi.mock("@/domain/assignments", () => ({
  acceptAssignment: (...args: unknown[]) => acceptAssignment(...args),
}))
vi.mock("@/hooks/useAssignmentRepoSetup", () => ({
  default: (...args: unknown[]) => {
    repoSetupSpy(...args)
    return {
      state: repoSetupState,
      isLoading: false,
      refetch: repoSetupRefetch,
    }
  },
}))
vi.mock("@/hooks/usePagesAssignments", () => ({
  default: (org?: string, classroom?: string, secret?: string) => {
    pagesAssignmentsSpy(org, classroom, secret)
    return {
      data: [
        {
          slug: "hello-python",
          name: "Hello Python",
          mode: "individual",
          autograder: "default",
          ...(assignmentClosed ? { closed: true } : {}),
          ...(assignmentEmptyRepo ? { empty_repo: true } : {}),
        },
      ],
      isLoading: false,
    }
  },
}))
vi.mock("@/hooks/useStudentClassrooms", () => ({
  useClassroomSecret: (
    _org?: string,
    classroom?: string,
    enabled = true,
  ): { secret: string | undefined; isLoading: boolean } => {
    if (!enabled || !classroom) return { secret: undefined, isLoading: false }
    return {
      secret: studentClassroomsData.find((c) => c.classroom === classroom)
        ?.secret,
      isLoading: false,
    }
  },
}))
vi.mock("@/hooks/useGetRepo", () => ({
  default: () => ({ data: existingRepo, isLoading: false }),
}))
vi.mock("@/hooks/useGetOwnOrgMembership", () => ({
  default: () => ({
    data: { state: "active", role: orgRole },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))
vi.mock("@/hooks/useClassroomEnrollment", () => ({
  useClassroomEnrollment: () => ({
    verdict: enrollmentVerdict,
    isLoading: false,
  }),
}))
vi.mock("@/hooks/mutations/useAcceptAndVerifyMembership", () => ({
  useAcceptAndVerifyMembership: () => ({
    isActive: true,
    isError: false,
    error: null,
    retry: vi.fn(),
  }),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))
vi.mock("@/auth/useGithubAuth", () => ({
  useGithubAuth: () => ({
    user: { id: 1, login: "student", name: "Test Student" },
  }),
}))
vi.mock("@/hooks/useDocumentTitle", () => ({
  useDocumentTitle: () => undefined,
}))
vi.mock("@/components/LanguageDialog", () => ({
  LanguageDialog: () => null,
}))
vi.mock("@/components/modals/GroupCollaboratorsModal", () => ({
  GroupCollaboratorsModal: () => null,
}))
vi.mock("canvas-confetti", () => ({ default: vi.fn() }))

// The health store fires a best-effort githubstatus.com probe once suspicion
// trips; stub it so these tests never hit the network.
vi.mock("@/lib/githubHealth/githubStatusApi", () => ({
  fetchGitHubStatusIndicator: () => Promise.resolve(null),
}))

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    // Renders the key plus its resolved params, so a test can tell a resolved
    // descriptor (params already substituted) from a leaked raw key.
    useTranslation: () => ({
      t: (key: string, params?: Record<string, string | number>) =>
        params
          ? `${key}:${Object.entries(params)
              .map(([name, value]) => `${name}=${String(value)}`)
              .join(",")}`
          : key,
    }),
  }
})

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    useParams: () => ({
      org: "acme",
      classroom: "cs101",
      assignment: "hello-python",
    }),
    useSearch: () => searchParams,
    Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  }
})

// RouterButton (createLink) needs a router context; stub just that primitive
// to a plain anchor so the accepted state renders without a RouterProvider.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>()
  return {
    ...actual,
    RouterButton: ({ children }: { children?: ReactNode }) => (
      <a href="/mock">{children}</a>
    ),
  }
})

import AcceptAssignmentPage from "./AcceptAssignmentPage"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"
import { __resetGitHubHealthForTest } from "@/lib/githubHealth/githubHealthStore"

const acceptedRepo: GitHubRepo = {
  id: 1,
  name: "cs101-hello-python-student",
  full_name: "acme/cs101-hello-python-student",
  private: true,
  default_branch: "main",
  ssh_url: "git@github.com:acme/cs101-hello-python-student.git",
  html_url: "https://github.com/acme/cs101-hello-python-student",
  permissions: {
    admin: false,
    maintain: false,
    push: true,
    pull: true,
  },
}

const orgReposKey = ["github", "org-repos", "acme"] as const

const renderPage = (client: QueryClient) =>
  render(
    <QueryClientProvider client={client}>
      <AcceptAssignmentPage />
    </QueryClientProvider>,
  )

beforeEach(() => {
  acceptAssignment.mockReset()
  pagesAssignmentsSpy.mockReset()
  searchParams.k = "test-secret"
  studentClassroomsData = []
  orgRole = "member"
  enrollmentVerdict = "enrolled"
  assignmentClosed = false
  assignmentEmptyRepo = false
  existingRepo = null
  repoSetupState = "complete"
  repoSetupRefetch.mockReset()
  repoSetupSpy.mockReset()
  __resetGitHubHealthForTest()
})

afterEach(() => {
  cleanup()
  __resetGitHubHealthForTest()
})

describe("AcceptAssignmentPage repository cache", () => {
  it.each(["created", "already-accepted"] as const)(
    "refreshes an inactive organization-repository query after %s",
    async (status) => {
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: Infinity },
          mutations: { retry: false },
        },
      })
      let resolveRefresh!: (repos: GitHubRepo[]) => void
      const refresh = new Promise<GitHubRepo[]>((resolve) => {
        resolveRefresh = resolve
      })
      const listRepos = vi
        .fn<() => Promise<GitHubRepo[]>>()
        .mockResolvedValueOnce([])
        .mockImplementationOnce(() => refresh)

      await client.prefetchQuery({
        queryKey: orgReposKey,
        queryFn: listRepos,
      })
      expect(
        client
          .getQueryCache()
          .find({
            queryKey: orgReposKey,
            exact: true,
          })
          ?.getObserversCount(),
      ).toBe(0)
      acceptAssignment.mockResolvedValue({
        status,
        repo: acceptedRepo,
        cloneCommand: "gh repo clone acme/repo",
      })

      renderPage(client)
      fireEvent.click(
        screen.getByRole("button", { name: "accept.acceptButton" }),
      )

      await waitFor(() => expect(acceptAssignment).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(listRepos).toHaveBeenCalledTimes(2))
      expect(screen.queryByText("accept.openRepository")).not.toBeNull()

      resolveRefresh([acceptedRepo])
      await waitFor(() =>
        expect(client.getQueryData(orgReposKey)).toEqual([acceptedRepo]),
      )
    },
  )
})

describe("AcceptAssignmentPage secret selection", () => {
  const renderWith = () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderPage(client)
  }

  it("uses the ?k= link secret when present", () => {
    searchParams.k = "test-secret"
    studentClassroomsData = [{ classroom: "cs101", secret: "team-secret" }]
    renderWith()
    expect(pagesAssignmentsSpy).toHaveBeenLastCalledWith(
      "acme",
      "cs101",
      "test-secret",
    )
  })

  it("falls back to the team-description secret for a bare accept link", () => {
    searchParams.k = undefined
    studentClassroomsData = [{ classroom: "cs101", secret: "team-secret" }]
    renderWith()
    expect(pagesAssignmentsSpy).toHaveBeenLastCalledWith(
      "acme",
      "cs101",
      "team-secret",
    )
  })

  it("treats an empty ?k= as absent and uses the team-description secret", () => {
    // A bare `?k=` (empty value) must not shadow the recovered team secret: the
    // enabled gate already treats "" as absent, so precedence must agree, or a
    // protected classroom fetches the unprotected path and 404s.
    searchParams.k = ""
    studentClassroomsData = [{ classroom: "cs101", secret: "team-secret" }]
    renderWith()
    expect(pagesAssignmentsSpy).toHaveBeenLastCalledWith(
      "acme",
      "cs101",
      "team-secret",
    )
  })

  it("passes no secret for a bare link when the student has no matching team", () => {
    searchParams.k = undefined
    studentClassroomsData = [{ classroom: "other", secret: "team-secret" }]
    renderWith()
    expect(pagesAssignmentsSpy).toHaveBeenLastCalledWith(
      "acme",
      "cs101",
      undefined,
    )
  })
})

describe("AcceptAssignmentPage step messages", () => {
  // Every step label, done-message, and remedy is a { key, params } descriptor
  // resolved here — the domain never assembles English, so a non-English student
  // no longer watches translated placeholders flip to English mid-run.
  const STEP_IDS = [
    "account",
    "membership",
    "assignment",
    "autograder",
    "repo",
    "access",
    "setup",
  ] as const

  const renderWithStepFailure = async (
    id: (typeof STEP_IDS)[number],
    error: { key: string; params?: Record<string, string | number> },
  ) => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    acceptAssignment.mockImplementation(
      (params: { onStepUpdate?: (u: unknown) => void }) => {
        params.onStepUpdate?.({ id, status: "error", error })
        return Promise.reject(
          Object.assign(new Error("diagnostic"), {
            localized: error,
          }),
        )
      },
    )
    renderPage(client)
    fireEvent.click(screen.getByRole("button", { name: "accept.acceptButton" }))
    await waitFor(() =>
      expect(screen.queryByText("accept.errorTitle")).not.toBeNull(),
    )
  }

  it.each(STEP_IDS)(
    "renders the resolved remedy, not a raw key, for the %s step",
    async (id) => {
      await renderWithStepFailure(id, {
        key: "accept.stepErrors.generic",
        params: { label: `accept.steps.${id}`, status: 403 },
      })

      // Present once in the checklist row and once in the error alert.
      expect(
        screen.queryAllByText(
          `accept.stepErrors.generic:label=accept.steps.${id},status=403`,
        ).length,
      ).toBeGreaterThan(0)
      // The pending placeholder for the failed step is replaced, not appended.
      expect(screen.queryByText(`accept.steps.${id}`)).toBeNull()
    },
  )

  it("renders a nested descriptor param (GitHub's own words) in the alert", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    acceptAssignment.mockRejectedValue(
      Object.assign(new Error("diagnostic"), {
        localized: {
          key: "accept.templateErrors.orgRepoCreationDenied",
          params: {
            org: "acme",
            status: 403,
            detail: {
              key: "accept.templateErrors.githubSaid",
              params: { message: "You need admin access" },
            },
          },
        },
      }),
    )
    renderPage(client)
    fireEvent.click(screen.getByRole("button", { name: "accept.acceptButton" }))
    await waitFor(() =>
      expect(screen.queryByText("accept.errorTitle")).not.toBeNull(),
    )

    expect(
      screen.queryByText(
        "accept.templateErrors.orgRepoCreationDenied:org=acme,status=403,detail=accept.templateErrors.githubSaid:message=You need admin access",
      ),
    ).not.toBeNull()
  })

  it("falls back to the generic copy for an error carrying no descriptor", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    acceptAssignment.mockRejectedValue(new TypeError("Failed to fetch"))
    renderPage(client)
    fireEvent.click(screen.getByRole("button", { name: "accept.acceptButton" }))
    await waitFor(() =>
      expect(screen.queryByText("accept.errorTitle")).not.toBeNull(),
    )

    expect(screen.queryByText("accept.errorGeneric")).not.toBeNull()
    // The browser's own English never reaches the student.
    expect(screen.queryByText("Failed to fetch")).toBeNull()
  })
})

describe("AcceptAssignmentPage outage hint", () => {
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

  // Mirrors AcceptStepError: a friendly wrapper preserving the underlying
  // GitHubAPIError as `.cause` (what the accept flow actually throws).
  class AcceptStepLike extends Error {
    constructor(message: string, cause?: unknown) {
      super(message)
      this.name = "AcceptStepError"
      if (cause !== undefined) this.cause = cause
    }
  }

  const STATUS_LINK = "githubStatus.checkStatusLink"

  const renderAndAccept = async (rejection: unknown) => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    acceptAssignment.mockRejectedValue(rejection)
    renderPage(client)
    fireEvent.click(screen.getByRole("button", { name: "accept.acceptButton" }))
    await waitFor(() =>
      expect(screen.queryByText("accept.errorTitle")).not.toBeNull(),
    )
  }

  it("shows the githubstatus.com hint when accept fails with a wrapped 5xx", async () => {
    await renderAndAccept(
      new AcceptStepLike("Provisioning failed (HTTP 502).", apiError(502)),
    )
    expect(screen.queryByText(STATUS_LINK)).not.toBeNull()
  })

  it("shows the hint when accept fails with a bare network error", async () => {
    await renderAndAccept(new TypeError("Failed to fetch"))
    expect(screen.queryByText(STATUS_LINK)).not.toBeNull()
  })

  it("does NOT show the hint for a wrapped 404 (not-found is a real, local problem)", async () => {
    await renderAndAccept(
      new AcceptStepLike("Repository not found (HTTP 404).", apiError(404)),
    )
    expect(screen.queryByText(STATUS_LINK)).toBeNull()
  })

  it("does NOT show the hint for a rate limit", async () => {
    await renderAndAccept(new AcceptStepLike("Rate limited.", apiError(429)))
    expect(screen.queryByText(STATUS_LINK)).toBeNull()
  })

  it("does NOT show the hint for a template-access error (teacher action, no cause)", async () => {
    // A TemplateAccessError is a plain Error with no outage `.cause`.
    await renderAndAccept(
      new Error("Couldn't copy the template — ask your teacher."),
    )
    expect(screen.queryByText(STATUS_LINK)).toBeNull()
  })
})

describe("AcceptAssignmentPage enrollment gate", () => {
  const renderWith = () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderPage(client)
  }

  it("blocks a member who is not enrolled in the classroom", () => {
    enrollmentVerdict = "not-enrolled"
    renderWith()
    expect(screen.queryByText("accept.notEnrolled.title")).not.toBeNull()
    expect(
      screen.queryByRole("button", { name: "accept.acceptButton" }),
    ).toBeNull()
  })

  it("lets an enrolled student reach the accept card", () => {
    enrollmentVerdict = "enrolled"
    renderWith()
    expect(screen.queryByText("accept.notEnrolled.title")).toBeNull()
    expect(
      screen.queryByRole("button", { name: "accept.acceptButton" }),
    ).not.toBeNull()
  })

  it("lets an org owner bypass the gate even when not enrolled", () => {
    enrollmentVerdict = "not-enrolled"
    orgRole = "admin"
    renderWith()
    expect(screen.queryByText("accept.notEnrolled.title")).toBeNull()
    expect(
      screen.queryByRole("button", { name: "accept.acceptButton" }),
    ).not.toBeNull()
  })

  it("fails open on an unresolved verdict (a transient team read)", () => {
    enrollmentVerdict = "unresolved"
    renderWith()
    expect(screen.queryByText("accept.notEnrolled.title")).toBeNull()
    expect(
      screen.queryByRole("button", { name: "accept.acceptButton" }),
    ).not.toBeNull()
  })
})

describe("AcceptAssignmentPage closed gate", () => {
  const renderWith = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    renderPage(client)
  }

  it("blocks a NEW accept on a closed assignment (no repo yet)", () => {
    assignmentClosed = true
    existingRepo = null
    renderWith()
    // The closed screen shows, and the accept CTA is gone.
    expect(screen.queryByText("accept.closed.title")).not.toBeNull()
    expect(
      screen.queryByRole("button", { name: "accept.acceptButton" }),
    ).toBeNull()
  })

  it("still lets an already-accepted student through (closed does not hide)", () => {
    assignmentClosed = true
    existingRepo = acceptedRepo
    renderWith()
    // Closed screen is NOT shown for a student whose repo already exists.
    expect(screen.queryByText("accept.closed.title")).toBeNull()
    // They reach their already-accepted view.
    expect(screen.queryByText("accept.alreadyAcceptedHeading")).not.toBeNull()
  })

  it("does not show the closed screen when the assignment is open", () => {
    assignmentClosed = false
    existingRepo = null
    renderWith()
    expect(screen.queryByText("accept.closed.title")).toBeNull()
    expect(
      screen.queryByRole("button", { name: "accept.acceptButton" }),
    ).not.toBeNull()
  })
})

// Issue #502: an existing repo isn't proof the accept finished. When the
// marker probe says the setup commit never landed, the page must lead with
// "Re-run setup" instead of a success-looking "Open repository".
describe("AcceptAssignmentPage incomplete setup", () => {
  const renderWith = () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderPage(client)
    return client
  }

  it("shows the incomplete-setup warning with a re-run button and demotes Open repository", () => {
    existingRepo = acceptedRepo
    repoSetupState = "incomplete"
    renderWith()

    expect(screen.queryByText("accept.setupIncomplete.title")).not.toBeNull()
    expect(screen.queryByText("accept.setupIncomplete.body")).not.toBeNull()
    // The re-run button is exposed directly, not behind the collapsed toggle.
    expect(
      screen.queryByRole("button", { name: "accept.repair.rerun" }),
    ).not.toBeNull()
    expect(screen.queryByText("accept.repair.havingTrouble")).toBeNull()
    // Open repository is still reachable but no longer the primary action.
    const open = screen.getByText("accept.openRepository").closest("a")
    expect(open?.className).toContain("btn-outline")
  })

  it("keeps the healthy already-accepted view when the marker is present", () => {
    existingRepo = acceptedRepo
    repoSetupState = "complete"
    renderWith()

    expect(screen.queryByText("accept.setupIncomplete.title")).toBeNull()
    expect(screen.queryByText("accept.repair.havingTrouble")).not.toBeNull()
    const open = screen.getByText("accept.openRepository").closest("a")
    expect(open?.className).not.toContain("btn-outline")
  })

  it("fails open on an unknown probe verdict (a transient read error)", () => {
    existingRepo = acceptedRepo
    repoSetupState = "unknown"
    renderWith()
    expect(screen.queryByText("accept.setupIncomplete.title")).toBeNull()
  })

  it("enables the probe only for an existing repo on a non-empty_repo assignment", () => {
    existingRepo = acceptedRepo
    renderWith()
    expect(repoSetupSpy).toHaveBeenLastCalledWith(
      "acme",
      acceptedRepo.name,
      expect.objectContaining({ enabled: true }),
    )
  })

  it("does not probe, or warn, for an empty_repo assignment", () => {
    existingRepo = acceptedRepo
    assignmentEmptyRepo = true
    // Even a stale "incomplete" from the mock must not surface: the page
    // decides from the assignment, not from the probe alone.
    repoSetupState = "incomplete"
    renderWith()
    expect(repoSetupSpy).toHaveBeenLastCalledWith(
      "acme",
      acceptedRepo.name,
      expect.objectContaining({ enabled: false }),
    )
    expect(screen.queryByText("accept.setupIncomplete.title")).toBeNull()
    expect(screen.queryByText("accept.repair.havingTrouble")).not.toBeNull()
  })

  it("does not probe before the student has a repo", () => {
    existingRepo = null
    renderWith()
    expect(repoSetupSpy).toHaveBeenLastCalledWith(
      "acme",
      expect.any(String),
      expect.objectContaining({ enabled: false }),
    )
  })

  it("re-runs the accept from the warning and re-probes the marker on success", async () => {
    existingRepo = acceptedRepo
    repoSetupState = "incomplete"
    acceptAssignment.mockResolvedValue({
      status: "already-accepted",
      repo: acceptedRepo,
      cloneCommand: "gh repo clone acme/repo",
    })
    renderWith()

    fireEvent.click(screen.getByRole("button", { name: "accept.repair.rerun" }))

    await waitFor(() => expect(acceptAssignment).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(repoSetupRefetch).toHaveBeenCalledTimes(1))
    // The heal succeeded this session, so the warning is gone even before the
    // probe's refetch lands.
    expect(screen.queryByText("accept.setupIncomplete.title")).toBeNull()
  })
})

// The accept is a chain of writes with no rollback: hold the tab while it runs
// and say why, then release it.
describe("AcceptAssignmentPage leave-page guard", () => {
  const renderWith = () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderPage(client)
  }

  it("blocks beforeunload and shows the keep-tab-open note only while the accept is pending", async () => {
    let finish!: (value: unknown) => void
    acceptAssignment.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    )
    renderWith()

    const fire = () => {
      const event = new Event("beforeunload", { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }

    expect(fire()).toBe(false)
    expect(screen.queryByText("accept.keepTabOpen")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "accept.acceptButton" }))
    await waitFor(() =>
      expect(screen.queryByText("accept.keepTabOpen")).not.toBeNull(),
    )
    expect(fire()).toBe(true)

    finish({
      status: "created",
      repo: acceptedRepo,
      cloneCommand: "gh repo clone acme/repo",
    })
    await waitFor(() =>
      expect(screen.queryByText("accept.keepTabOpen")).toBeNull(),
    )
    expect(fire()).toBe(false)
  })
})
