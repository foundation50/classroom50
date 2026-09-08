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
vi.mock("@/hooks/mutations/useBulkAssignmentActions", () => ({
  useBulkSetAssignmentClosed: () => ({ mutateAsync: setClosedMutateAsync }),
}))

import { BulkCloseSubmissionModal } from "./BulkCloseSubmissionModal"
import { GitHubAPIError } from "@/github-core/errors"
import type { CloseSubmissionTarget } from "@/components/bulk/closeSubmissionFanOut"

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

const committed = (changed: string[], missing: string[] = []) => ({
  changed,
  missing,
  newCommitSha: "NEWCOMMIT",
})

afterEach(() => {
  cleanup()
  addMutateAsync.mockReset()
  setClosedMutateAsync.mockReset()
})

function renderModal(
  mode: "close" | "reopen",
  targets: CloseSubmissionTarget[],
  skipped: string[] = [],
) {
  return render(
    <BulkCloseSubmissionModal
      open
      onClose={() => {}}
      org="o"
      classroom="cs"
      mode={mode}
      targets={targets}
      skipped={skipped}
    />,
  )
}

describe("BulkCloseSubmissionModal", () => {
  it("close: one commit for the selection, then every accepted repo to pull", async () => {
    setClosedMutateAsync.mockResolvedValue(committed(["hw1", "hw2"]))
    addMutateAsync.mockResolvedValue({ effective: undefined })
    renderModal("close", [
      { slug: "hw1", owners: ["alice", "bob"] },
      { slug: "hw2", owners: ["alice"] },
    ])

    fireEvent.click(screen.getByText("assignments.bulk.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("assignments.bulk.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(setClosedMutateAsync).toHaveBeenCalledTimes(1)
    expect(setClosedMutateAsync).toHaveBeenCalledWith({
      slugs: ["hw1", "hw2"],
      closed: true,
    })
    expect(addMutateAsync).toHaveBeenCalledTimes(3)
    expect(addMutateAsync).toHaveBeenCalledWith({
      org: "o",
      repo: "cs-hw2-alice",
      username: "alice",
      permission: "pull",
      verify: true,
    })
  })

  it("reopen: commits closed=false, then restores push", async () => {
    setClosedMutateAsync.mockResolvedValue(committed(["hw1"]))
    addMutateAsync.mockResolvedValue({ effective: undefined })
    renderModal("reopen", [{ slug: "hw1", owners: ["alice"] }])

    fireEvent.click(
      screen.getByText("assignments.bulk.closeSubmission.reopenApply"),
    )

    await waitFor(() =>
      expect(
        screen.getByText(
          "assignments.bulk.closeSubmission.reopenResultHeadline",
        ),
      ).toBeTruthy(),
    )
    expect(setClosedMutateAsync).toHaveBeenCalledWith({
      slugs: ["hw1"],
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

  // The commit is the whole selection's, so its failure changes nothing.
  it("if the commit fails, no repository is touched and an error shows", async () => {
    setClosedMutateAsync.mockRejectedValue(apiError(500))
    renderModal("close", [{ slug: "hw1", owners: ["alice", "bob"] }])

    fireEvent.click(screen.getByText("assignments.bulk.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.flagError"),
      ).toBeTruthy(),
    )
    expect(addMutateAsync).not.toHaveBeenCalled()
  })

  // A slug deleted between render and submit has no repos to reach either.
  it("skips the repositories of an assignment that vanished before the commit", async () => {
    setClosedMutateAsync.mockResolvedValue(committed(["hw1"], ["hw2"]))
    addMutateAsync.mockResolvedValue({ effective: undefined })
    renderModal("close", [
      { slug: "hw1", owners: ["alice"] },
      { slug: "hw2", owners: ["bob"] },
    ])

    fireEvent.click(screen.getByText("assignments.bulk.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("assignments.bulk.closeSubmission.missingSection"),
      ).toBeTruthy(),
    )
    expect(addMutateAsync).toHaveBeenCalledTimes(1)
    expect(addMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "cs-hw1-alice" }),
    )
  })

  // A rate limit has to stop the rest of the SELECTION, not just the
  // assignment that tripped it.
  it("stops at a secondary rate-limit and defers the remaining assignments", async () => {
    setClosedMutateAsync.mockResolvedValue(committed(["hw1", "hw2"]))
    addMutateAsync.mockImplementation(() => Promise.reject(apiError(429)))
    renderModal("close", [
      {
        slug: "hw1",
        owners: Array.from({ length: 12 }, (_, i) => `student${i}`),
      },
      { slug: "hw2", owners: ["alice", "bob"] },
    ])

    fireEvent.click(screen.getByText("assignments.bulk.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText(
          "assignments.bulk.closeSubmission.resultHeadlineThrottled",
        ),
      ).toBeTruthy(),
    )
    expect(
      screen.getByText("submissions.closeSubmission.deferredSection"),
    ).toBeTruthy()
    // hw2's owners were never launched.
    expect(
      addMutateAsync.mock.calls.some((call) =>
        (call[0] as { repo: string }).repo.startsWith("cs-hw2-"),
      ),
    ).toBe(false)
  })

  it("closes a selection nobody accepted: commits the flag, runs no fan-out", async () => {
    setClosedMutateAsync.mockResolvedValue(committed(["hw1"]))
    renderModal("close", [{ slug: "hw1", owners: [] }])

    fireEvent.click(screen.getByText("assignments.bulk.closeSubmission.apply"))

    await waitFor(() =>
      expect(setClosedMutateAsync).toHaveBeenCalledWith({
        slugs: ["hw1"],
        closed: true,
      }),
    )
    expect(addMutateAsync).not.toHaveBeenCalled()
  })

  it("offers 'finish closing' after a throttled close and re-runs without committing again", async () => {
    setClosedMutateAsync.mockResolvedValue(committed(["hw1"]))
    addMutateAsync.mockImplementation(() => Promise.reject(apiError(429)))
    renderModal("close", [{ slug: "hw1", owners: ["alice", "bob"] }])

    fireEvent.click(screen.getByText("assignments.bulk.closeSubmission.apply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.finishApply"),
      ).toBeTruthy(),
    )
    expect(setClosedMutateAsync).toHaveBeenCalledTimes(1)

    addMutateAsync.mockReset()
    addMutateAsync.mockResolvedValue({ effective: undefined })
    fireEvent.click(screen.getByText("submissions.closeSubmission.finishApply"))

    await waitFor(() =>
      expect(
        screen.getByText("assignments.bulk.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    // Still one commit: the finish-only re-run is the fan-out alone.
    expect(setClosedMutateAsync).toHaveBeenCalledTimes(1)
    expect(addMutateAsync).toHaveBeenCalledTimes(2)
  })

  it("names the selected assignments the action leaves alone", () => {
    renderModal(
      "close",
      [{ slug: "hw1", owners: ["alice"] }],
      ["team1", "bare"],
    )

    expect(
      screen.getByText("assignments.bulk.closeSubmission.skipped"),
    ).toBeTruthy()
  })
})
