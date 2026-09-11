// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type PropsWithChildren } from "react"

vi.mock("@/context/github/GitHubProvider", () => ({
  useOptionalGitHubClient: () => ({}),
}))

const getRunAnnotations = vi.fn()
const getPagesDeploymentStatus = vi.fn()
vi.mock("@/github-core/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/github-core/queries")>()
  return {
    ...actual,
    getRunAnnotations: (...args: unknown[]) => getRunAnnotations(...args),
    getPagesDeploymentStatus: (...args: unknown[]) =>
      getPagesDeploymentStatus(...args),
  }
})

import { usePublishFailureDetail } from "./usePublishFailureDetail"

const wrapper = ({ children }: PropsWithChildren) =>
  createElement(
    QueryClientProvider,
    {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    },
    children,
  )

const BLOCKER = "656e8d140b36230c9ccfe14584b9a81fa8c9c8d0"
const lockAnnotation = {
  level: "failure",
  message: `Failed to create deployment (status: 400) with build version 8f00. Responded with: Deployment request failed for 8f00 due to in progress deployment. Please cancel ${BLOCKER} first or wait for it to complete.`,
}

describe("usePublishFailureDetail", () => {
  beforeEach(() => {
    getRunAnnotations.mockReset()
    getPagesDeploymentStatus.mockReset()
  })

  it("reads nothing without a run id", () => {
    const { result } = renderHook(
      () => usePublishFailureDetail("acme", undefined),
      { wrapper },
    )
    expect(result.current).toEqual({ state: "unknown" })
    expect(getRunAnnotations).not.toHaveBeenCalled()
  })

  it("names the deploy lock and probes the blocking deployment", async () => {
    getRunAnnotations.mockResolvedValue([lockAnnotation])
    getPagesDeploymentStatus.mockResolvedValue("updating_pages")

    const { result } = renderHook(() => usePublishFailureDetail("acme", 77), {
      wrapper,
    })
    expect(result.current).toEqual({ state: "loading" })

    await waitFor(() =>
      expect(result.current).toEqual({
        state: "known",
        failure: { kind: "deployLocked", blockerSha: BLOCKER },
        blockerInProgress: true,
      }),
    )
    expect(getPagesDeploymentStatus.mock.calls[0].slice(1, 3)).toEqual([
      "acme",
      BLOCKER,
    ])
  })

  it("reports the lock as cleared once GitHub no longer holds the blocker", async () => {
    getRunAnnotations.mockResolvedValue([lockAnnotation])
    // 404 -> null: the deployment expired or was cancelled.
    getPagesDeploymentStatus.mockResolvedValue(null)

    const { result } = renderHook(() => usePublishFailureDetail("acme", 77), {
      wrapper,
    })
    await waitFor(() =>
      expect(result.current).toMatchObject({
        state: "known",
        blockerInProgress: false,
      }),
    )
  })

  it("does not probe for a cause other than the lock", async () => {
    getRunAnnotations.mockResolvedValue([
      { level: "failure", message: "Timeout reached, aborting!" },
    ])
    const { result } = renderHook(() => usePublishFailureDetail("acme", 77), {
      wrapper,
    })
    await waitFor(() =>
      expect(result.current).toEqual({
        state: "known",
        failure: { kind: "timeout" },
      }),
    )
    expect(getPagesDeploymentStatus).not.toHaveBeenCalled()
  })

  it("falls back to unknown when the annotations name no known cause or can't be read", async () => {
    getRunAnnotations.mockResolvedValue([
      { level: "failure", message: "Process completed with exit code 1." },
    ])
    const first = renderHook(() => usePublishFailureDetail("acme", 77), {
      wrapper,
    })
    await waitFor(() =>
      expect(first.result.current).toEqual({ state: "unknown" }),
    )

    getRunAnnotations.mockRejectedValue(new Error("403"))
    const second = renderHook(() => usePublishFailureDetail("acme", 78), {
      wrapper,
    })
    await waitFor(() =>
      expect(second.result.current).toEqual({ state: "unknown" }),
    )
  })
})
