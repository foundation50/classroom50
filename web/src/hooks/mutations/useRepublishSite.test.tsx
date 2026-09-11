// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type PropsWithChildren } from "react"

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))

const register = vi.fn()
vi.mock("@/context/actions/ActionActivityProvider", () => ({
  useActionActivityRegistry: () => ({ register }),
}))

const triggerPublishPages = vi.fn()
vi.mock("@/github-core/mutations", () => ({
  triggerPublishPages: (...args: unknown[]) => triggerPublishPages(...args),
}))

import { useRepublishSite } from "./useRepublishSite"

const wrapper = ({ children }: PropsWithChildren) =>
  createElement(QueryClientProvider, { client: new QueryClient() }, children)

describe("useRepublishSite", () => {
  it("registers the dispatched run with the banner as a publish-pages dispatch tracker", async () => {
    triggerPublishPages.mockResolvedValue({ sinceRunId: 41 })
    const { result } = renderHook(() => useRepublishSite(), { wrapper })
    result.current.mutate({ org: "acme", label: "Publishing to student site" })
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1))
    expect(triggerPublishPages.mock.calls[0][1]).toBe("acme")
    expect(register).toHaveBeenCalledWith({
      org: "acme",
      label: "Publishing to student site",
      anchor: {
        kind: "sinceRunId",
        workflow: "publish-pages.yaml",
        sinceRunId: 41,
      },
    })
  })

  it("registers nothing when the dispatch is refused", async () => {
    register.mockClear()
    triggerPublishPages.mockRejectedValue(new Error("403"))
    const { result } = renderHook(() => useRepublishSite(), { wrapper })
    result.current.mutate({ org: "acme", label: "x" })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(register).not.toHaveBeenCalled()
  })
})
