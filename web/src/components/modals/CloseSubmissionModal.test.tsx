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

const setTeamPermissionMutateAsync = vi.fn()
vi.mock("@/hooks/mutations/useSetTeamRepoPermission", () => ({
  default: () => ({ mutateAsync: setTeamPermissionMutateAsync }),
  useSetTeamRepoPermission: () => ({
    mutateAsync: setTeamPermissionMutateAsync,
  }),
}))

const listDirectCollaborators = vi.fn()
vi.mock("@/github-core/repoReads", () => ({
  listDirectCollaborators: (...args: unknown[]) =>
    listDirectCollaborators(...args),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

import {
  CloseSubmissionModal,
  type CloseSubmissionTargets,
} from "./CloseSubmissionModal"
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
  setTeamPermissionMutateAsync.mockReset()
  listDirectCollaborators.mockReset()
})

const individual = (owners: string[]): CloseSubmissionTargets => ({
  kind: "individual",
  owners,
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
      targets={individual(owners)}
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

  it("'finish closing' keeps setting pull even after the parent flips mode to reopen (#1152)", async () => {
    // The parent derives `mode` from the assignment's `closed` flag, which the
    // first run flips, so by the time the result shows the prop reads "reopen".
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    addMutateAsync.mockImplementation(() => Promise.reject(apiError(429)))
    const view = renderModal("close", ["alice", "bob"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.finishApply"),
      ).toBeTruthy(),
    )

    view.rerender(
      <CloseSubmissionModal
        open
        onClose={() => {}}
        org="o"
        classroom="cs"
        assignment="hw1"
        mode="reopen"
        targets={individual(["alice", "bob"])}
      />,
    )
    // The result still reads as a close, not a reopen.
    expect(screen.getByText("submissions.closeSubmission.title")).toBeTruthy()
    expect(
      screen.getByText("submissions.closeSubmission.finishApply"),
    ).toBeTruthy()

    addMutateAsync.mockReset()
    addMutateAsync.mockResolvedValue({ effective: undefined })
    fireEvent.click(screen.getByText("submissions.closeSubmission.finishApply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(setClosedMutateAsync).toHaveBeenCalledTimes(1)
    expect(addMutateAsync).toHaveBeenCalledTimes(2)
    for (const [params] of addMutateAsync.mock.calls) {
      expect(params.permission).toBe("pull")
    }
  })

  it("does not offer 'finish closing' when the only misses are roles GitHub kept", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    // alice is an org owner: the PUT succeeds but she stays admin. Retrying
    // can't change that, so the modal explains instead of offering a re-run.
    addMutateAsync.mockImplementation(({ username }: { username: string }) =>
      Promise.resolve({
        effective:
          username === "alice"
            ? { permission: "admin", role_name: "admin" }
            : undefined,
      }),
    )
    renderModal("close", ["alice", "bob"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.failedSection"),
      ).toBeTruthy(),
    )
    expect(
      screen.getByText("submissions.closeSubmission.notAppliedHint.lead"),
    ).toBeTruthy()
    // The row keeps only its fact; the hint carries the explanation once.
    expect(
      screen.getByText("submissions.closeSubmission.keptRole"),
    ).toBeTruthy()
    expect(
      screen.queryByText("components.modals.repoAccess.notApplied"),
    ).toBeNull()
    expect(
      screen.queryByText("submissions.closeSubmission.finishApply"),
    ).toBeNull()
    expect(
      screen.queryByText("submissions.closeSubmission.finishHint"),
    ).toBeNull()
    expect(screen.getByText("common.done")).toBeTruthy()
  })

  it("offers 'finish closing' for the retryable misses alongside a kept role", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    addMutateAsync.mockImplementation(({ username }: { username: string }) =>
      username === "alice"
        ? Promise.resolve({
            effective: { permission: "admin", role_name: "admin" },
          })
        : Promise.reject(apiError(500)),
    )
    renderModal("close", ["alice", "bob"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.finishApply"),
      ).toBeTruthy(),
    )
    expect(
      screen.getByText("submissions.closeSubmission.finishHint"),
    ).toBeTruthy()
    expect(
      screen.getByText("submissions.closeSubmission.notAppliedHint.lead"),
    ).toBeTruthy()

    // Finish closing retries only the miss a re-run can fix: not alice (kept
    // role) and not anyone already read-only.
    addMutateAsync.mockReset()
    addMutateAsync.mockResolvedValue({ effective: undefined })
    fireEvent.click(screen.getByText("submissions.closeSubmission.finishApply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(addMutateAsync).toHaveBeenCalledTimes(1)
    expect(addMutateAsync.mock.calls[0][0]).toMatchObject({
      username: "bob",
      permission: "pull",
    })
  })

  it("finish closing retries only the deferred owners, not the ones already read-only", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    // alice lands; bob trips the secondary rate limit, so carol is deferred.
    addMutateAsync.mockImplementation(({ username }: { username: string }) =>
      username === "alice"
        ? Promise.resolve({ effective: undefined })
        : Promise.reject(apiError(429)),
    )
    renderModal("close", ["alice", "bob", "carol"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.finishApply"),
      ).toBeTruthy(),
    )

    addMutateAsync.mockReset()
    addMutateAsync.mockResolvedValue({ effective: undefined })
    fireEvent.click(screen.getByText("submissions.closeSubmission.finishApply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(addMutateAsync.mock.calls.map(([p]) => p.username)).toEqual([
      "bob",
      "carol",
    ])
  })

  it("re-opening the modal after a close follows the parent's mode again", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    addMutateAsync.mockResolvedValue({ effective: undefined })
    const view = renderModal("close", ["alice"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )

    // Dismiss, then the teacher opens it again; the parent now says "reopen".
    const props = {
      onClose: () => {},
      org: "o",
      classroom: "cs",
      assignment: "hw1",
      targets: individual(["alice"]),
    }
    view.rerender(<CloseSubmissionModal {...props} open={false} mode="close" />)
    view.rerender(<CloseSubmissionModal {...props} open mode="reopen" />)

    expect(
      screen.getByText("submissions.closeSubmission.reopenTitle"),
    ).toBeTruthy()
    expect(
      screen.queryByText("submissions.closeSubmission.finishApply"),
    ).toBeNull()

    setClosedMutateAsync.mockReset()
    setClosedMutateAsync.mockResolvedValue({ closed: false })
    addMutateAsync.mockReset()
    addMutateAsync.mockResolvedValue({ effective: undefined })
    fireEvent.click(screen.getByText("submissions.closeSubmission.reopenApply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.reopenResultHeadline"),
      ).toBeTruthy(),
    )
    expect(setClosedMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ closed: false }),
    )
    expect(addMutateAsync.mock.calls[0][0]).toMatchObject({
      permission: "push",
    })
  })

  it("keeps the close direction when the parent flips mode while the fan-out is in flight", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    const view = renderModal("close", ["alice", "bob"])
    // The first write resolves only after the parent has re-rendered with
    // mode="reopen", the way the listing refetch lands mid-run in production.
    addMutateAsync.mockImplementation(() => {
      view.rerender(
        <CloseSubmissionModal
          open
          onClose={() => {}}
          org="o"
          classroom="cs"
          assignment="hw1"
          mode="reopen"
          targets={individual(["alice", "bob"])}
        />,
      )
      return Promise.reject(apiError(429))
    })

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.finishApply"),
      ).toBeTruthy(),
    )
    expect(screen.getByText("submissions.closeSubmission.title")).toBeTruthy()
    expect(
      screen.getByText("submissions.closeSubmission.resultHeadlineThrottled"),
    ).toBeTruthy()

    addMutateAsync.mockReset()
    addMutateAsync.mockResolvedValue({ effective: undefined })
    fireEvent.click(screen.getByText("submissions.closeSubmission.finishApply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    for (const [params] of addMutateAsync.mock.calls) {
      expect(params.permission).toBe("pull")
    }
  })

  it("reopen: a read-back below write is a plain failure, with no close-only hints", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: false })
    addMutateAsync.mockResolvedValue({
      effective: { permission: "read", role_name: "read" },
    })
    renderModal("reopen", ["alice"])

    fireEvent.click(screen.getByText("submissions.closeSubmission.reopenApply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.failedSection"),
      ).toBeTruthy(),
    )
    expect(screen.getByText("common.done")).toBeTruthy()
    expect(
      screen.queryByText("submissions.closeSubmission.finishApply"),
    ).toBeNull()
    expect(
      screen.queryByText("submissions.closeSubmission.finishHint"),
    ).toBeNull()
    expect(
      screen.queryByText("submissions.closeSubmission.notAppliedHint.lead"),
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

describe("CloseSubmissionModal on shared repos", () => {
  function renderGroupModal(
    mode: "close" | "reopen",
    repos: Extract<CloseSubmissionTargets, { kind: "group" }>["repos"],
  ) {
    return render(
      <CloseSubmissionModal
        open
        onClose={() => {}}
        org="o"
        classroom="cs"
        assignment="hw1"
        mode={mode}
        targets={{ kind: "group", repos }}
      />,
    )
  }

  it("legacy group: shows the group copy and sets every direct collaborator to pull", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    listDirectCollaborators.mockImplementation((_client, _org, repo: string) =>
      Promise.resolve(
        repo === "cs-hw1-alice"
          ? [{ login: "alice" }, { login: "bob" }]
          : [{ login: "carol" }],
      ),
    )
    addMutateAsync.mockResolvedValue({ effective: undefined })
    renderGroupModal("close", [
      { owner: "alice", repoName: "cs-hw1-alice" },
      { owner: "carol", repoName: "cs-hw1-carol" },
    ])

    expect(
      screen.getByText("submissions.closeSubmission.warningGroup"),
    ).toBeTruthy()
    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(setClosedMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ closed: true }),
    )
    // No team in the legacy flavor: only collaborator writes.
    expect(setTeamPermissionMutateAsync).not.toHaveBeenCalled()
    expect(
      addMutateAsync.mock.calls
        .map(([p]) => `${p.repo}:${p.username}:${p.permission}`)
        .toSorted(),
    ).toEqual([
      "cs-hw1-alice:alice:pull",
      "cs-hw1-alice:bob:pull",
      "cs-hw1-carol:carol:pull",
    ])
  })

  it("team mode: sets the team's role first, then the direct collaborators", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    const order: string[] = []
    setTeamPermissionMutateAsync.mockImplementation((p) => {
      order.push(`team:${p.teamSlug}:${p.permission}`)
      return Promise.resolve()
    })
    listDirectCollaborators.mockResolvedValue([{ login: "dana" }])
    addMutateAsync.mockImplementation((p) => {
      order.push(`collab:${p.username}:${p.permission}`)
      return Promise.resolve({ effective: undefined })
    })
    renderGroupModal("close", [
      {
        owner: "group-1",
        repoName: "cs-hw1-group-1",
        teamSlug: "cs-hw1-group-1",
        label: "Team Rocket",
      },
    ])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(setTeamPermissionMutateAsync).toHaveBeenCalledWith({
      org: "o",
      teamSlug: "cs-hw1-group-1",
      repo: "cs-hw1-group-1",
      permission: "pull",
    })
    expect(order).toEqual(["team:cs-hw1-group-1:pull", "collab:dana:pull"])
  })

  it("team mode reopen restores push on the team and the collaborators", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: false })
    setTeamPermissionMutateAsync.mockResolvedValue(undefined)
    listDirectCollaborators.mockResolvedValue([{ login: "dana" }])
    addMutateAsync.mockResolvedValue({ effective: undefined })
    renderGroupModal("reopen", [
      { owner: "group-1", repoName: "cs-hw1-group-1", teamSlug: "t-1" },
    ])

    fireEvent.click(screen.getByText("submissions.closeSubmission.reopenApply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.reopenResultHeadline"),
      ).toBeTruthy(),
    )
    expect(setTeamPermissionMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "push" }),
    )
    expect(addMutateAsync.mock.calls[0][0]).toMatchObject({
      username: "dana",
      permission: "push",
    })
  })

  it("names the members GitHub kept, lists the group by its label, and offers no retry", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    listDirectCollaborators.mockResolvedValue([
      { login: "alice" },
      { login: "bob" },
    ])
    // alice is an org owner: her role sticks; bob's write lands.
    addMutateAsync.mockImplementation(({ username }: { username: string }) =>
      Promise.resolve({
        effective:
          username === "alice"
            ? { permission: "admin", role_name: "admin" }
            : undefined,
      }),
    )
    renderGroupModal("close", [
      { owner: "alice", repoName: "cs-hw1-alice", label: "Alice's group" },
    ])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.failedSection"),
      ).toBeTruthy(),
    )
    expect(screen.getByText("Alice's group")).toBeTruthy()
    expect(
      screen.getByText("submissions.closeSubmission.keptRoleMembers"),
    ).toBeTruthy()
    expect(
      screen.getByText("submissions.closeSubmission.notAppliedHint.leadGroup"),
    ).toBeTruthy()
    expect(
      screen.queryByText("submissions.closeSubmission.finishApply"),
    ).toBeNull()
  })

  it("a failed collaborator read fails the whole group and offers finish closing for it", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    listDirectCollaborators.mockImplementation((_client, _org, repo: string) =>
      repo === "cs-hw1-alice"
        ? Promise.reject(apiError(500))
        : Promise.resolve([{ login: "carol" }]),
    )
    addMutateAsync.mockResolvedValue({ effective: undefined })
    renderGroupModal("close", [
      { owner: "alice", repoName: "cs-hw1-alice" },
      { owner: "carol", repoName: "cs-hw1-carol" },
    ])

    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.finishApply"),
      ).toBeTruthy(),
    )

    // Finish closing retries only alice's group.
    listDirectCollaborators.mockReset()
    listDirectCollaborators.mockResolvedValue([{ login: "alice" }])
    addMutateAsync.mockReset()
    addMutateAsync.mockResolvedValue({ effective: undefined })
    fireEvent.click(screen.getByText("submissions.closeSubmission.finishApply"))
    await waitFor(() =>
      expect(
        screen.getByText("submissions.closeSubmission.resultHeadline"),
      ).toBeTruthy(),
    )
    expect(setClosedMutateAsync).toHaveBeenCalledTimes(1)
    expect(listDirectCollaborators.mock.calls.map((c) => c[2])).toEqual([
      "cs-hw1-alice",
    ])
    expect(addMutateAsync.mock.calls.map(([p]) => p.username)).toEqual([
      "alice",
    ])
  })

  it("closes with no group repos yet: flips the flag, shows the group empty state", async () => {
    setClosedMutateAsync.mockResolvedValue({ closed: true })
    renderGroupModal("close", [])

    expect(
      screen.getByText("submissions.closeSubmission.noReposGroup"),
    ).toBeTruthy()
    fireEvent.click(screen.getByText("submissions.closeSubmission.apply"))

    await waitFor(() =>
      expect(setClosedMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ closed: true }),
      ),
    )
    expect(listDirectCollaborators).not.toHaveBeenCalled()
    expect(addMutateAsync).not.toHaveBeenCalled()
  })
})
