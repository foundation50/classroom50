// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const notify = vi.fn()
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify, dismiss: vi.fn() }),
}))

const collect = vi.fn()
const hookArgs: unknown[][] = []
let phase = "idle"
let failure: "dispatch" | "run" | null = null
let error: unknown = null
let run: unknown = null
vi.mock("@/hooks/useTriggerScoreCollection", () => ({
  default: (...args: unknown[]) => {
    hookArgs.push(args)
    return { collect, phase, failure, run, error }
  },
}))

// Freshness inputs, both already served from the query cache in the app.
let scoresResult: { data?: unknown; isLoading: boolean; error?: unknown } = {
  data: undefined,
  isLoading: false,
}
vi.mock("@/hooks/useGetScores", () => ({
  default: () => scoresResult,
}))

let lastRunResult: { data?: unknown } = { data: undefined }
vi.mock("@/hooks/useGetLastCollectScoresRun", () => ({
  default: () => lastRunResult,
}))

// The two staleness inputs. Both are served from the query cache on the real
// page (the assignments table holds the same two query keys).
let assignmentsResult: { data?: unknown } = { data: undefined }
vi.mock("@/hooks/useGetClassAssignments", () => ({
  default: () => assignmentsResult,
}))

let orgReposResult: { data?: unknown } = { data: undefined }
vi.mock("@/hooks/useGetMyOrgRepos", () => ({
  default: () => orgReposResult,
}))

import { ClassroomCollectButton } from "./ClassroomCollectButton"
import { GitHubAPIError } from "@/github-core/errors"

// A settled scores.json read failure, as jsonFileQuery surfaces it.
const scoresReadError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/repos/acme/classroom50/contents/cs50%2Fscores.json",
    message: status === 404 ? "Not Found" : `boom ${status}`,
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

// One client + spy per test, handed back inferred so the recorded filters keep
// their types.
const setup = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const invalidate = vi.spyOn(client, "invalidateQueries")
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return {
    wrapper,
    invalidate,
    invalidatedKeys: () =>
      invalidate.mock.calls.map((call) => call[0]?.queryKey),
  }
}

const collectButton = () =>
  screen.getByRole("button", { name: "assignments.collect.label" })

beforeEach(() => {
  collect.mockReset()
  notify.mockReset()
  hookArgs.length = 0
  phase = "idle"
  failure = null
  error = null
  run = null
  scoresResult = { data: undefined, isLoading: false }
  lastRunResult = { data: undefined }
  assignmentsResult = { data: undefined }
  orgReposResult = { data: undefined }
  // happy-dom's <dialog> lacks showModal/close; stub them so the confirm
  // modal's open-sync effect can run.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
    this.dispatchEvent(new Event("close"))
  }
})

afterEach(cleanup)

describe("ClassroomCollectButton", () => {
  it("confirms before dispatching a classroom-wide collect (no assignment in the scope)", () => {
    const { wrapper } = setup()
    render(<ClassroomCollectButton org="acme" classroom="cs50" />, { wrapper })
    fireEvent.click(collectButton())

    // The click only opens the confirmation; the sweep is heavier than a
    // per-assignment collect, so nothing dispatches until it's confirmed.
    expect(collect).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "assignments.collect.confirmAction" }),
    )

    expect(collect).toHaveBeenCalledTimes(1)
    expect(hookArgs[0]).toEqual(["acme", { classroom: "cs50" }])
  })

  it("does not dispatch when the confirmation is cancelled", () => {
    const { wrapper } = setup()
    render(<ClassroomCollectButton org="acme" classroom="cs50" />, { wrapper })
    fireEvent.click(collectButton())
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }))

    expect(collect).not.toHaveBeenCalled()
  })

  it("explains itself and does not dispatch while the roster is empty", () => {
    const { wrapper } = setup()
    render(<ClassroomCollectButton org="acme" classroom="cs50" emptyRoster />, {
      wrapper,
    })

    expect((collectButton() as HTMLButtonElement).disabled).toBe(true)
    expect(collectButton().getAttribute("title")).toBe(
      "submissions.collect.titleEmptyRoster",
    )
    fireEvent.click(collectButton())
    expect(collect).not.toHaveBeenCalled()
  })

  it("drops the cached gradebook when the run completes", () => {
    phase = "running"
    const { wrapper, invalidate, invalidatedKeys } = setup()
    const { rerender } = render(
      <ClassroomCollectButton org="acme" classroom="cs50" />,
      { wrapper },
    )
    expect(invalidate).not.toHaveBeenCalled()

    phase = "completed"
    rerender(<ClassroomCollectButton org="acme" classroom="cs50" />)

    expect(invalidatedKeys()).toContainEqual(
      expect.arrayContaining(["json-file", "acme", "cs50/scores.json"]),
    )
    expect(invalidatedKeys()).toContainEqual(
      expect.arrayContaining(["last-collect-scores-run", "acme"]),
    )
    // `pushed_at` is frozen at page load; the re-read unfreezes it so the badge
    // re-derives against the post-sweep repo list.
    expect(invalidatedKeys()).toContainEqual(
      expect.arrayContaining(["org-repos", "acme"]),
    )
  })

  // The poll giving up says nothing about the run, which usually lands — so the
  // stale reads go either way.
  it("drops the cached gradebook when the poll times out", () => {
    phase = "running"
    const { wrapper, invalidatedKeys } = setup()
    const { rerender } = render(
      <ClassroomCollectButton org="acme" classroom="cs50" />,
      { wrapper },
    )

    phase = "timeout"
    rerender(<ClassroomCollectButton org="acme" classroom="cs50" />)

    expect(invalidatedKeys()).toContainEqual(
      expect.arrayContaining(["json-file", "acme", "cs50/scores.json"]),
    )
  })

  // A rejected dispatch never registers with the Actions banner (registration
  // rides the mutation's success), so this toast is its only surface.
  it("reports a dispatch that never landed", () => {
    phase = "dispatching"
    const { wrapper } = setup()
    const { rerender } = render(
      <ClassroomCollectButton org="acme" classroom="cs50" />,
      { wrapper },
    )

    phase = "failed"
    failure = "dispatch"
    error = new Error("Resource not accessible by personal access token")
    rerender(<ClassroomCollectButton org="acme" classroom="cs50" />)

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error", key: "collect-scores:cs50" }),
    )
  })

  // A run that concluded non-success is "failed" on the hook too, but it has a
  // banner row of its own — toasting it would report the one failure twice.
  it("leaves a failed run to the Actions banner", () => {
    phase = "running"
    const { wrapper } = setup()
    const { rerender } = render(
      <ClassroomCollectButton org="acme" classroom="cs50" />,
      { wrapper },
    )

    phase = "failed"
    failure = "run"
    rerender(<ClassroomCollectButton org="acme" classroom="cs50" />)

    expect(notify).not.toHaveBeenCalled()
  })

  // The i18n mock returns bare keys, so the assertions match keys, not copy.
  describe("freshness line", () => {
    it("reads never-collected when there is no scores.json", () => {
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(
        screen.getByText("submissions.freshness.neverCollected"),
      ).toBeTruthy()
    })

    it("reads collected from the buckets' collected_at stamps", () => {
      scoresResult = {
        data: {
          submissions: {},
          collectedAt: {
            hw1: "2026-06-01T00:00:00Z",
            hw2: "2026-06-02T00:00:00Z",
          },
          detected: {},
        },
        isLoading: false,
      }
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.getByText("submissions.freshness.collected")).toBeTruthy()
    })

    // A stamped file never borrows the org-wide run timestamp (that run may
    // have swept another classroom); a wholly unstamped file predates the
    // stamping collector, when every run was org-wide, so the fallback holds.
    it("falls back to the org-wide run only for a wholly unstamped file", () => {
      scoresResult = {
        data: { submissions: {}, collectedAt: {}, detected: {} },
        isLoading: false,
      }
      lastRunResult = {
        data: { status: "completed", created_at: "2026-06-01T00:00:00Z" },
      }
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.getByText("submissions.freshness.collected")).toBeTruthy()
    })

    it("ignores a run that has not completed", () => {
      scoresResult = {
        data: { submissions: {}, collectedAt: {}, detected: {} },
        isLoading: false,
      }
      lastRunResult = {
        data: { status: "in_progress", created_at: "2026-06-01T00:00:00Z" },
      }
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(
        screen.getByText("submissions.freshness.neverCollected"),
      ).toBeTruthy()
    })

    it("stays silent while scores.json is still loading", () => {
      scoresResult = { data: undefined, isLoading: true }
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.queryByText("submissions.freshness.collected")).toBeNull()
      expect(
        screen.queryByText("submissions.freshness.neverCollected"),
      ).toBeNull()
    })
  })

  // Classroom-wide staleness: one badge, on the same strings the submissions
  // page uses, driven per assignment rather than by a classroom-wide maximum.
  describe("out-of-date badge", () => {
    const withRepos = (pushed: Record<string, string>) => ({
      data: Object.entries(pushed).map(([name, pushed_at]) => ({
        name,
        pushed_at,
      })),
    })
    const withScores = (collectedAt: Record<string, string>) => ({
      data: { submissions: {}, collectedAt, detected: {} },
      isLoading: false,
    })

    beforeEach(() => {
      assignmentsResult = { data: { assignments: [{ slug: "hw1" }] } }
    })

    it("flags a bucket pushed after its own collect", () => {
      orgReposResult = withRepos({ "cs50-hw1-alice": "2026-06-02T00:00:00Z" })
      scoresResult = withScores({ hw1: "2026-06-01T00:00:00Z" })
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.getByText("submissions.freshness.stale")).toBeTruthy()
    })

    it("stays quiet when every bucket was collected after its push", () => {
      orgReposResult = withRepos({ "cs50-hw1-alice": "2026-06-01T00:00:00Z" })
      scoresResult = withScores({ hw1: "2026-06-02T00:00:00Z" })
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.queryByText("submissions.freshness.stale")).toBeNull()
    })

    // The repo list is a whole-org pagination, so an unanswerable question is
    // left unasked — and an unanswered one never claims the data is current.
    it("shows no badge while the repo list is unavailable", () => {
      orgReposResult = { data: undefined }
      scoresResult = withScores({ hw1: "2026-06-01T00:00:00Z" })
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.queryByText("submissions.freshness.stale")).toBeNull()
    })

    // collect_scores.py skips a bare empty_repo assignment outright, so its
    // bucket is never written and never stamped — while its student repos
    // exist and carry an accept-time push. Measured, it would latch the badge
    // on forever with no collect able to clear it.
    it("never latches on an empty_repo assignment, which is never collected", () => {
      assignmentsResult = {
        data: {
          assignments: [
            { slug: "hw1" },
            { slug: "reflection", empty_repo: true },
          ],
        },
      }
      orgReposResult = withRepos({
        "cs50-hw1-alice": "2026-06-01T00:00:00Z",
        "cs50-reflection-alice": "2026-06-05T00:00:00Z",
      })
      scoresResult = withScores({ hw1: "2026-06-03T00:00:00Z" })
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.queryByText("submissions.freshness.stale")).toBeNull()
    })

    // Before scores.json lands every bucket looks unstamped. The collected
    // line is suppressed in that window precisely to avoid a false claim; the
    // badge must not make one either.
    it("claims nothing while scores.json is still loading", () => {
      assignmentsResult = { data: { assignments: [{ slug: "hw1" }] } }
      orgReposResult = withRepos({ "cs50-hw1-alice": "2026-06-02T00:00:00Z" })
      scoresResult = { data: undefined, isLoading: true }
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.queryByText("submissions.freshness.stale")).toBeNull()
    })

    // The wiring the app actually uses: scores.json is partially stamped, so a
    // slug with no stamp of its own must not borrow a sibling's — the caller
    // hands in the newest stamp as the run fallback, and it has to be ignored
    // while any bucket is stamped.
    it("doesn't let a collected assignment mask a never-collected one", () => {
      assignmentsResult = {
        data: { assignments: [{ slug: "hw1" }, { slug: "hw2" }] },
      }
      orgReposResult = withRepos({
        "cs50-hw1-alice": "2026-06-01T00:00:00Z",
        "cs50-hw2-bob": "2026-06-01T00:00:00Z",
      })
      // hw1 collected after its push; hw2 has no stamp at all.
      scoresResult = withScores({ hw1: "2026-06-03T00:00:00Z" })
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.getByText("submissions.freshness.stale")).toBeTruthy()
    })

    // Pins the sixth-argument wiring: an EXCLUDED empty_repo slug must still
    // guard its prefix sibling, or "hw1" absorbs "hw1-bonus"'s newer push and
    // latches a badge no collect can clear. Fails if the component ever hands
    // classroomSnapshotIsStale an incomplete `allSlugs` list.
    it("keeps an excluded empty_repo sibling guarding its prefix", () => {
      assignmentsResult = {
        data: {
          assignments: [
            { slug: "hw1" },
            { slug: "hw1-bonus", empty_repo: true },
          ],
        },
      }
      orgReposResult = withRepos({
        "cs50-hw1-alice": "2026-06-01T00:00:00Z",
        "cs50-hw1-bonus-bob": "2026-06-05T00:00:00Z",
      })
      scoresResult = withScores({ hw1: "2026-06-03T00:00:00Z" })
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.queryByText("submissions.freshness.stale")).toBeNull()
    })

    // A settled read with no file (404) IS the never-collected state: repos
    // carry pushes and nothing was ever collected, so the badge may speak.
    it("shows the badge for a pushed, never-collected classroom", () => {
      orgReposResult = withRepos({ "cs50-hw1-alice": "2026-06-02T00:00:00Z" })
      scoresResult = {
        data: undefined,
        isLoading: false,
        error: scoresReadError(404),
      }
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.getByText("submissions.freshness.stale")).toBeTruthy()
    })

    // ...but a read that FAILED (rate limit, network) answered nothing, so
    // claiming "Out of date" from it would be the false claim the loading
    // gate already avoids.
    it("claims nothing when the scores read failed", () => {
      orgReposResult = withRepos({ "cs50-hw1-alice": "2026-06-02T00:00:00Z" })
      scoresResult = {
        data: undefined,
        isLoading: false,
        error: scoresReadError(403),
      }
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.queryByText("submissions.freshness.stale")).toBeNull()
    })

    // A wholly unstamped legacy file leans on the completed-run query, which
    // lags — it can still report the PRIOR run right after a sweep finishes.
    // The tracked run this component just watched to completion outranks it,
    // so the badge clears instead of relighting against yesterday's run.
    it("trusts a just-completed tracked sweep over the lagging run query", () => {
      orgReposResult = withRepos({ "cs50-hw1-alice": "2026-06-02T00:00:00Z" })
      scoresResult = withScores({})
      lastRunResult = {
        data: { status: "completed", created_at: "2026-06-01T00:00:00Z" },
      }
      phase = "completed"
      run = { created_at: "2026-06-03T00:00:00Z" }
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(screen.queryByText("submissions.freshness.stale")).toBeNull()
    })
  })
})
