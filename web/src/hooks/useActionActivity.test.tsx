// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type PropsWithChildren } from "react"

import type { GitHubWorkflowRun } from "@/github-core/types"
import type { ActionOperation } from "@/util/actionActivity"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
    }),
  }
})
vi.mock("@/hooks/useActiveOrg", () => ({ useActiveOrg: () => "acme" }))
vi.mock("@/context/github/GitHubProvider", () => ({
  useOptionalGitHubClient: () => ({}),
}))

const notify = vi.fn()
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useOptionalToast: () => ({ notify }),
}))

// The registry is driven by the test: `ops` is what operationsForOrg returns.
let ops: ActionOperation[] = []
const clearOp = vi.fn()
const dismiss = vi.fn()
vi.mock("@/context/actions/ActionActivityProvider", () => ({
  useActionActivityRegistry: () => ({
    operationsForOrg: () => ops,
    lastRegisteredAt: () => 0,
    isDismissed: () => false,
    dismiss,
    clearOp,
  }),
}))

let runs: GitHubWorkflowRun[] = []
vi.mock("@/github-core/activityRuns", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/github-core/activityRuns")>()
  return { ...actual, listActiveAndRecentRuns: async () => runs }
})

const rerunFailedRun = vi.fn<(...args: unknown[]) => Promise<void>>(
  async () => undefined,
)
vi.mock("@/github-core/mutations", () => ({
  rerunFailedRun: (...args: unknown[]) => rerunFailedRun(...args),
}))

// The cancel mutation is a stub whose call-site callbacks the test fires by
// hand, so the cancel -> retry sequence can be stepped through.
type CancelCallbacks = {
  onSuccess?: () => void
  onError?: (err: unknown) => void
  onSettled?: () => void
}
const cancelMutate =
  vi.fn<
    (vars: { org: string; deploymentId: string }, cb: CancelCallbacks) => void
  >()
vi.mock("@/hooks/mutations/useCancelPagesDeployment", () => ({
  useCancelPagesDeployment: () => ({ mutate: cancelMutate }),
}))

import { useActionActivity } from "./useActionActivity"

const run = (over: Partial<GitHubWorkflowRun>): GitHubWorkflowRun =>
  ({
    id: 1,
    status: "completed",
    conclusion: "success",
    event: "push",
    path: ".github/workflows/publish-pages.yaml",
    created_at: "2026-09-11T10:00:00Z",
    run_started_at: "2026-09-11T10:00:00Z",
    updated_at: "2026-09-11T10:01:00Z",
    html_url: "https://github.com/acme/classroom50/actions/runs/1",
    ...over,
  }) as GitHubWorkflowRun

const publishOp = (id: string, sha: string): ActionOperation => ({
  id,
  org: "acme",
  label: `Publishing ${id}`,
  anchor: { kind: "sha", sha },
  startedAt: Date.now(),
})

let queryClient: QueryClient
const wrapper = ({ children }: PropsWithChildren) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

const renderActivity = () => renderHook(() => useActionActivity(), { wrapper })

describe("useActionActivity", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    ops = []
    runs = []
    notify.mockReset()
    clearOp.mockReset()
    rerunFailedRun.mockClear()
    cancelMutate.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("reads a cancelled publish as superseded when a newer publish succeeded", async () => {
    ops = [publishOp("op-a", "aaa")]
    runs = [
      run({ id: 11, head_sha: "bbb" }),
      run({ id: 10, head_sha: "aaa", conclusion: "cancelled" }),
    ]
    const { result } = renderActivity()
    await waitFor(() =>
      expect(result.current.trackers[0]?.phase).toBe("superseded"),
    )
    const tracker = result.current.trackers[0]
    expect(tracker.workflow).toBe("publish-pages.yaml")
    expect(tracker.dismissible).toBe(true)
    expect(tracker.retriable).toBe(false)
    expect(tracker.displayLabel).toBe(
      'actionsBanner.state.superseded:{"label":"Publishing op-a"}',
    )
  })

  it("keeps a cancelled publish failed (and retriable) when the newer publish failed", async () => {
    ops = [publishOp("op-a", "aaa")]
    runs = [
      run({ id: 11, head_sha: "bbb", conclusion: "failure" }),
      run({ id: 10, head_sha: "aaa", conclusion: "cancelled" }),
    ]
    const { result } = renderActivity()
    await waitFor(() =>
      expect(result.current.trackers[0]?.phase).toBe("failed"),
    )
    expect(result.current.trackers[0].retriable).toBe(true)
    expect(result.current.anyFailed).toBe(true)
  })

  it("auto-dismisses once every tracker has succeeded or been superseded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    ops = [publishOp("op-a", "aaa"), publishOp("op-b", "bbb")]
    runs = [
      run({ id: 11, head_sha: "bbb" }),
      run({ id: 10, head_sha: "aaa", conclusion: "cancelled" }),
    ]
    const { result } = renderActivity()
    await waitFor(() =>
      expect(result.current.trackers.map((tr) => tr.phase).sort()).toEqual([
        "success",
        "superseded",
      ]),
    )
    expect(clearOp).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_100)
    })
    expect(clearOp.mock.calls.map((c) => c[0]).sort()).toEqual(["op-a", "op-b"])
  })

  it("unstick cancels the blocker, disables Retry meanwhile, then re-runs once", async () => {
    ops = [publishOp("op-a", "aaa")]
    runs = [run({ id: 10, head_sha: "aaa", conclusion: "failure" })]
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderActivity()
    await waitFor(() =>
      expect(result.current.trackers[0]?.retriable).toBe(true),
    )

    act(() => result.current.unstick("op-a", "656e8d"))
    expect(cancelMutate).toHaveBeenCalledTimes(1)
    expect(cancelMutate.mock.calls[0][0]).toEqual({
      org: "acme",
      deploymentId: "656e8d",
    })
    expect(result.current.busy.has("op-a")).toBe(true)
    expect(result.current.unsticking.has("op-a")).toBe(true)

    // Retry (and a second unstick) are no-ops while the cancel is in flight.
    act(() => result.current.retry("op-a"))
    act(() => result.current.unstick("op-a", "656e8d"))
    expect(rerunFailedRun).not.toHaveBeenCalled()
    expect(cancelMutate).toHaveBeenCalledTimes(1)

    const callbacks = cancelMutate.mock.calls[0][1]
    act(() => {
      callbacks.onSuccess?.()
      callbacks.onSettled?.()
    })
    await waitFor(() => expect(rerunFailedRun).toHaveBeenCalledTimes(1))
    expect(rerunFailedRun.mock.calls[0].slice(1)).toEqual(["acme", 10])
    await waitFor(() => expect(result.current.busy.has("op-a")).toBe(false))
    // A retry re-reads the run's annotations (same run id after
    // rerun-failed-jobs) as well as the run list.
    expect(
      invalidate.mock.calls.some(
        (c) =>
          JSON.stringify(c[0]?.queryKey) ===
          JSON.stringify(["github", "run-annotations", "acme", 10]),
      ),
    ).toBe(true)
  })

  it("reports a failed cancel through the toast and does not re-run", async () => {
    ops = [publishOp("op-a", "aaa")]
    runs = [run({ id: 10, head_sha: "aaa", conclusion: "failure" })]
    const { result } = renderActivity()
    await waitFor(() =>
      expect(result.current.trackers[0]?.retriable).toBe(true),
    )
    act(() => result.current.unstick("op-a", "656e8d"))
    const callbacks = cancelMutate.mock.calls[0][1]
    act(() => {
      callbacks.onError?.(new Error("Forbidden"))
      callbacks.onSettled?.()
    })
    expect(rerunFailedRun).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({
      tone: "error",
      message: expect.stringContaining(
        "actionsBanner.publishFailure.unstickFailed",
      ),
    })
    expect(result.current.busy.has("op-a")).toBe(false)
  })
})
