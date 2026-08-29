// @vitest-environment happy-dom
// Pins the error-vs-empty split (Primer degraded experiences): a failed read
// must surface isError so pages never render their first-use empty states on
// it, while a 404 stays the legitimate zero for a fresh org.
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

import { GitHubAPIError } from "@/github-core/errors"

let responseStatus = 500
let responseBody: string | null = null

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({
    requestRaw: (path: string) =>
      responseBody !== null
        ? Promise.resolve(responseBody)
        : Promise.reject(
            new GitHubAPIError({
              status: responseStatus,
              url: `https://api.github.com${path}`,
              message: `HTTP ${responseStatus}`,
              body: null,
              rateLimit: {} as never,
            }),
          ),
  }),
}))

import useGetClasses from "./useGetClasses"

afterEach(() => {
  cleanup()
  responseStatus = 500
  responseBody = null
})

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
)

describe("useGetClasses error-vs-empty split", () => {
  it("surfaces a non-404 failure as isError", async () => {
    responseStatus = 500
    const { result } = renderHook(() => useGetClasses("acme"), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.classes).toEqual([])
  })

  it("treats a 404 as the legitimate empty, not an error", async () => {
    responseStatus = 404
    const { result } = renderHook(() => useGetClasses("acme"), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isError).toBe(false)
    expect(result.current.classes).toEqual([])
  })

  it("filters the listing to classroom dirs on success", async () => {
    responseBody = JSON.stringify([
      { type: "dir", name: "cs50" },
      { type: "dir", name: ".github" },
      { type: "file", name: "README.md" },
    ])
    const { result } = renderHook(() => useGetClasses("acme"), { wrapper })
    await waitFor(() => expect(result.current.classes).toHaveLength(1))
    expect(result.current.isError).toBe(false)
    expect(result.current.classes[0]?.name).toBe("cs50")
  })
})
