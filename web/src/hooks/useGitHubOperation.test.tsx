// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"

import { useGitHubOperation } from "./useGitHubOperation"
import type { GitHubWorkflowRun } from "@/github-core/types"

const MINUTE = 60 * 1000
const TIMEOUT_MS = 10 * MINUTE
const QUEUE_TIMEOUT_MS = 30 * MINUTE
// The tracker never waits longer than the two windows back to back.
const MAX_WAIT_MS = TIMEOUT_MS + QUEUE_TIMEOUT_MS
const T0 = new Date("2026-08-24T12:00:00.000Z")
const STORAGE_KEY = "test:operation"

const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs).toISOString()

const makeRun = (over: Partial<GitHubWorkflowRun> = {}): GitHubWorkflowRun => ({
  id: 2,
  status: "queued",
  conclusion: null,
  created_at: at(0),
  html_url: "https://github.com/acme/config/actions/runs/2",
  event: "workflow_dispatch",
  ...over,
})

// The run the poll currently sees, and what the dispatch does. Both are swapped
// per test; the poll re-reads `currentRun` on every refetch, so a test can move
// a run from queued to in_progress by reassigning it and advancing the clock.
let currentRun: GitHubWorkflowRun | null = null
let dispatchImpl: () => Promise<{ sinceRunId: number | null }> = async () => ({
  sinceRunId: 1,
})

const mount = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(
    () =>
      useGitHubOperation({
        storageKey: STORAGE_KEY,
        queryKey: (sinceRunId) => ["operation", sinceRunId],
        resetKey: "acme",
        timeoutMs: TIMEOUT_MS,
        queueTimeoutMs: QUEUE_TIMEOUT_MS,
        // Poll on a flat one-minute cadence so the advance amounts below read
        // as wall-clock, not as a backoff schedule.
        intervalMs: MINUTE,
        backoffAfterMs: MINUTE,
        backoffIntervalMs: MINUTE,
        dispatch: () => dispatchImpl(),
        findRun: async () => currentRun,
      }),
    { wrapper },
  )
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

// Dispatch and let the first poll land, so the hook is tracking a run.
const start = async (view: ReturnType<typeof mount>) => {
  await act(async () => {
    view.result.current.trigger()
  })
  await advance(MINUTE)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  sessionStorage.clear()
  currentRun = null
  dispatchImpl = async () => ({ sinceRunId: 1 })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// GitHub's own `timeout-minutes` caps execution only. A run held in an Actions
// concurrency group is healthy, so the client must not expire it — doing so
// drops the tracked dispatch and re-enables the trigger for a duplicate.
describe("queue time", () => {
  it("keeps waiting while the run sits queued past the execution window", async () => {
    currentRun = makeRun({ status: "queued" })
    const view = mount()
    await start(view)

    await advance(TIMEOUT_MS + MINUTE)

    expect(view.result.current.phase).toBe("running")
  })

  it("starts the execution window when the run leaves the queue", async () => {
    currentRun = makeRun({ status: "queued" })
    const view = mount()
    await start(view)

    // Queued for 20 minutes — twice the execution window — then running, which
    // puts the deadline at minute 30 (run start + the execution window) rather
    // than minute 10 (dispatch + the same window).
    await advance(20 * MINUTE)
    currentRun = makeRun({
      status: "in_progress",
      run_started_at: at(20 * MINUTE),
    })
    await advance(2 * MINUTE)
    expect(view.result.current.phase).toBe("running")

    // Minute 29: past the dispatch-anchored window, inside the run's own.
    await advance(6 * MINUTE)
    expect(view.result.current.phase).toBe("running")

    // Minute 31.
    await advance(2 * MINUTE)
    expect(view.result.current.phase).toBe("timeout")
  })

  it("gives up once the queue window elapses with the run still parked", async () => {
    currentRun = makeRun({ status: "queued" })
    const view = mount()
    await start(view)

    await advance(QUEUE_TIMEOUT_MS + MINUTE)

    expect(view.result.current.phase).toBe("timeout")
  })

  it("caps the wait when the run reports a start stamp skewed ahead", async () => {
    currentRun = makeRun({
      status: "in_progress",
      run_started_at: at(10 * 60 * MINUTE),
    })
    const view = mount()
    await start(view)

    await advance(MAX_WAIT_MS + MINUTE)

    expect(view.result.current.phase).toBe("timeout")
  })
})

// "failed" covers both a rejected POST and a run that concluded non-success.
// Callers that also surface run outcomes need to tell the two apart.
describe("failure attribution", () => {
  it("attributes a rejected dispatch to the dispatch", async () => {
    dispatchImpl = async () => {
      throw new Error("Resource not accessible by personal access token")
    }
    const view = mount()
    await start(view)

    expect(view.result.current.phase).toBe("failed")
    expect(view.result.current.failure).toBe("dispatch")
  })

  it("attributes a non-success conclusion to the run", async () => {
    currentRun = makeRun({ status: "completed", conclusion: "failure" })
    const view = mount()
    await start(view)

    expect(view.result.current.phase).toBe("failed")
    expect(view.result.current.failure).toBe("run")
  })

  it("leaves a successful run unattributed", async () => {
    currentRun = makeRun({ status: "completed", conclusion: "success" })
    const view = mount()
    await start(view)

    expect(view.result.current.phase).toBe("completed")
    expect(view.result.current.failure).toBeNull()
  })
})
