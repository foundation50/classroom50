// @vitest-environment happy-dom
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const mutateAsync = vi.fn()
vi.mock("@/hooks/mutations/useSetRepoPages", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/mutations/useSetRepoPages")>()
  return {
    ...actual,
    default: () => ({ mutateAsync }),
    useSetRepoPages: () => ({ mutateAsync }),
  }
})

// The branch-source-without-a-branch path reads each repo's default branch.
const getRepo = vi.fn()
vi.mock("@/github-core/repoReads", () => ({
  getRepo: (...args: unknown[]) => getRepo(...args),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

import { BulkRepoPagesModal } from "./BulkRepoPagesModal"
import { GitHubAPIError } from "@/github-core/errors"
import type { AssignmentPages } from "@/types/classroom"

function rateLimitError(): GitHubAPIError {
  return new GitHubAPIError({
    status: 429,
    url: "/repos/o/cs-site-alice/pages",
    message: "HTTP 429",
    body: null,
    rateLimit: {
      limit: null,
      remaining: 0,
      used: null,
      reset: null,
      resource: null,
      retryAfter: 60,
    },
  })
}

afterEach(() => {
  cleanup()
  mutateAsync.mockReset()
  getRepo.mockReset()
})

function renderModal(owners: string[], pages: AssignmentPages) {
  return render(
    <BulkRepoPagesModal
      open
      onClose={() => {}}
      org="o"
      classroom="cs"
      assignment="site"
      pages={pages}
      owners={owners}
    />,
  )
}

const applyBtn = "submissions.bulkPages.apply"

describe("BulkRepoPagesModal", () => {
  it("POSTs a workflow site per repo without any repo read", async () => {
    mutateAsync.mockResolvedValue({ enabled: true, alreadyEnabled: false })
    renderModal(["alice", "bob"], { source: "workflow" })
    fireEvent.click(screen.getByText(applyBtn))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.bulkPages.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(mutateAsync).toHaveBeenCalledTimes(2)
    expect(mutateAsync).toHaveBeenCalledWith({
      org: "o",
      repo: "cs-site-alice",
      body: { build_type: "workflow" },
    })
    expect(getRepo).not.toHaveBeenCalled()
  })

  it("resolves each repo's default branch for a branch source with none named", async () => {
    getRepo.mockResolvedValue({ default_branch: "master" })
    mutateAsync.mockResolvedValue({ enabled: true, alreadyEnabled: true })
    renderModal(["alice"], { source: "branch", path: "/docs" })
    fireEvent.click(screen.getByText(applyBtn))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.bulkPages.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(getRepo).toHaveBeenCalledTimes(1)
    expect(mutateAsync).toHaveBeenCalledWith({
      org: "o",
      repo: "cs-site-alice",
      body: {
        build_type: "legacy",
        source: { branch: "master", path: "/docs" },
      },
    })
    // An already-configured site counts as done, not a failure.
    expect(screen.queryByText("submissions.bulkPages.failedSection")).toBeNull()
  })

  it("reports a classified refusal as a failure row and keeps going", async () => {
    mutateAsync
      .mockResolvedValueOnce({ enabled: true, alreadyEnabled: false })
      .mockResolvedValueOnce({
        enabled: false,
        reason: "plan",
        error: new Error("x"),
      })
    renderModal(["alice", "bob"], { source: "workflow" })
    fireEvent.click(screen.getByText(applyBtn))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.bulkPages.failedSection"),
      ).toBeTruthy(),
    )
    expect(mutateAsync).toHaveBeenCalledTimes(2)
    expect(screen.getByText("submissions.rowPages.refused.plan")).toBeTruthy()
  })

  it("stops launching on a rate limit and defers the rest (never 'access')", async () => {
    // Mirrors BulkRepoFeaturesModal: enableRepoPages rethrows a throttle, so
    // the fan-out marks the remainder deferred instead of hammering GitHub
    // and mislabelling every remaining student as an access refusal.
    const owners = Array.from({ length: 12 }, (_, i) => `student${i}`)
    mutateAsync.mockImplementation(() => Promise.reject(rateLimitError()))
    renderModal(owners, { source: "workflow" })
    fireEvent.click(screen.getByText(applyBtn))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.bulkPages.resultHeadlineThrottled"),
      ).toBeTruthy(),
    )
    expect(
      screen.getByText("submissions.bulkPages.deferredSection"),
    ).toBeTruthy()
    expect(screen.queryByText("submissions.rowPages.refused.access")).toBeNull()
    expect(mutateAsync.mock.calls.length).toBeLessThan(owners.length)
  })

  it("reports an unresolvable default branch without POSTing", async () => {
    getRepo.mockResolvedValue(null)
    renderModal(["alice"], { source: "branch" })
    fireEvent.click(screen.getByText(applyBtn))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.bulkPages.failedSection"),
      ).toBeTruthy(),
    )
    expect(screen.getByText("submissions.rowPages.refused.branch")).toBeTruthy()
    expect(mutateAsync).not.toHaveBeenCalled()
  })
})
