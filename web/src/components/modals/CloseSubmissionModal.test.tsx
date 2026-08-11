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

const addMutateAsync = vi.fn()
vi.mock("@/hooks/mutations/useAddRepoCollaborator", () => ({
  default: () => ({ mutateAsync: addMutateAsync }),
  useAddRepoCollaborator: () => ({ mutateAsync: addMutateAsync }),
}))

const setClosedMutateAsync = vi.fn()
vi.mock("@/hooks/mutations/useSetAssignmentClosed", () => ({
  default: () => ({ mutateAsync: setClosedMutateAsync }),
  useSetAssignmentClosed: () => ({ mutateAsync: setClosedMutateAsync }),
}))

import { CloseSubmissionModal } from "./CloseSubmissionModal"
import { GitHubAPIError } from "@/github-core/errors"

function apiError(status: number): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "/repos/o/cs-hw1-bob",
    message: `HTTP ${status}`,
    body: null,
    rateLimit: {
      limit: null,
      remaining: null,
      used: null,
      reset: null,
      resource: null,
      retryAfter: null,
    },
  })
}

afterEach(() => {
  cleanup()
  addMutateAsync.mockReset()
  setClosedMutateAsync.mockReset()
})

function renderModal(mode: "close" | "reopen", owners: string[]) {
  return render(
    <CloseSubmissionModal
      open
      onClose={() => {}}
      org="o"
      classroom="cs"
      assignment="hw1"
      mode={mode}
      owners={owners}
    />,
  )
}

describe("CloseSubmissionModal", () => {
  it("close: flips closed=true then sets every repo to pull", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    addMutateAsync.mockResolvedValue({ effective: undefined })
    renderModal("close", ["alice", "bob"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(setClosedMutateAsync).toHaveBeenCalledWith({
      org: "o",
      classroom: "cs",
      slug: "hw1",
      closed: true,
    })
    expect(addMutateAsync).toHaveBeenCalledTimes(2)
    expect(addMutateAsync).toHaveBeenCalledWith({
      org: "o",
      repo: "cs-hw1-alice",
      username: "alice",
      permission: "pull",
      verify: true,
    })
  })

  it("reopen: flips closed=false then restores push", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: false })
    addMutateAsync.mockResolvedValue({ effective: undefined })
    renderModal("reopen", ["alice"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.reopenApply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.reopenResultHeadline"),
      ).toBeTruthy(),
    )
    expect(setClosedMutateAsync).toHaveBeenCalledWith({
      org: "o",
      classroom: "cs",
      slug: "hw1",
      closed: false,
    })
    expect(addMutateAsync).toHaveBeenCalledWith({
      org: "o",
      repo: "cs-hw1-alice",
      username: "alice",
      permission: "push",
      verify: true,
    })
  })

  it("if the flag write fails, no repos are touched and an error shows", async () => {
    setClosedMutateAsync.mockRejectedValue(apiError(500))
    renderModal("close", ["alice", "bob"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.flagError"),
      ).toBeTruthy(),
    )
    expect(addMutateAsync).not.toHaveBeenCalled()
  })

  it("reports a silently-ignored downgrade (residual higher role) as failed", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    // Requested pull but effective is still admin => not applied.
    addMutateAsync.mockResolvedValue({
      effective: { permission: "admin", role_name: "admin" },
    })
    renderModal("close", ["alice"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.failedSection"),
      ).toBeTruthy(),
    )
  })

  it("stops launching on a secondary rate-limit and defers the rest", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    const owners = Array.from({ length: 12 }, (_, i) => `student${i}`)
    addMutateAsync.mockImplementation(() => Promise.reject(apiError(429)))
    renderModal("close", owners)

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadlineThrottled"),
      ).toBeTruthy(),
    )
    expect(
      screen.getByText("submissions.closeSubmission.deferredSection"),
    ).toBeTruthy()
    expect(addMutateAsync.mock.calls.length).toBeLessThan(owners.length)
  })

  it("closes with zero accepted repos: flips the flag, no fan-out", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    renderModal("close", [])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(setClosedMutateAsync).toHaveBeenCalledWith({
        org: "o",
        classroom: "cs",
        slug: "hw1",
        closed: true,
      }),
    )
    expect(addMutateAsync).not.toHaveBeenCalled()
  })

  it("offers 'finish closing' after a throttled close and re-runs the fan-out without flipping the flag again", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    // First attempt: the very first write is rate-limited, deferring the rest.
    addMutateAsync.mockImplementation(() => Promise.reject(apiError(429)))
    renderModal("close", ["alice", "bob"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.finishApply"),
      ).toBeTruthy(),
    )
    // The finish hint explains the flag is already committed.
    expect(
      screen.getByText("submissions.closeSubmission.finishHint"),
    ).toBeTruthy()
    expect(setClosedMutateAsync).toHaveBeenCalledTimes(1)

    // Finish closing: this time the writes succeed.
    addMutateAsync.mockReset()
    addMutateAsync.mockResolvedValue({ effective: undefined })
    fireEvent.click(screen.getByText("submissions.closeSubmission.finishApply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    // The flag was NOT flipped again — finish-only re-runs the fan-out.
    expect(setClosedMutateAsync).toHaveBeenCalledTimes(1)
    expect(addMutateAsync).toHaveBeenCalledTimes(2)
    // And once the fan-out completes cleanly, the finish affordance is gone.
    expect(
      screen.queryByText("submissions.closeSubmission.finishApply"),
    ).toBeNull()
  })

  it("reopen tolerates a residual role at or above write (floor comparison)", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: false })
    // Requested push but the student legitimately holds admin — benign on reopen.
    addMutateAsync.mockResolvedValue({
      effective: { permission: "admin", role_name: "admin" },
    })
    renderModal("reopen", ["alice"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.reopenApply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.reopenResultHeadline"),
      ).toBeTruthy(),
    )
    // No failed section: a higher-than-requested role is not a reopen failure.
    expect(
      screen.queryByText("submissions.closeSubmission.failedSection"),
    ).toBeNull()
  })
})
