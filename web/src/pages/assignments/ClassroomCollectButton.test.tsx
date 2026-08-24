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
let error: unknown = null
vi.mock("@/hooks/useTriggerScoreCollection", () => ({
  default: (...args: unknown[]) => {
    hookArgs.push(args)
    return { collect, phase, run: null, error }
  },
}))

// Freshness inputs, both already served from the query cache in the app.
let scoresResult: { data?: unknown; isLoading: boolean } = {
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

import { ClassroomCollectButton } from "./ClassroomCollectButton"

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
  error = null
  scoresResult = { data: undefined, isLoading: false }
  lastRunResult = { data: undefined }
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
    error = new Error("Resource not accessible by personal access token")
    rerender(<ClassroomCollectButton org="acme" classroom="cs50" />)

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error", key: "collect-scores:cs50" }),
    )
  })

  // The i18n mock returns bare keys, so the assertions match keys, not copy.
  describe("freshness line", () => {
    it("reads never-synced when there is no scores.json", () => {
      const { wrapper } = setup()
      render(<ClassroomCollectButton org="acme" classroom="cs50" />, {
        wrapper,
      })

      expect(
        screen.getByText("submissions.freshness.neverCollected"),
      ).toBeTruthy()
    })

    it("reads synced from the buckets' collected_at stamps", () => {
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
})
