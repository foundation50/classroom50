// @vitest-environment happy-dom
// Pins the error-vs-empty split for the roster read: a failed roster.csv read
// surfaces isError (so views never render "empty roster" on it), while a
// missing file (404) stays the legitimate zero for a new classroom.
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

import useGetStudents from "./useGetStudents"

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

describe("useGetStudents error-vs-empty split", () => {
  it("surfaces a non-404 failure as isError", async () => {
    responseStatus = 500
    const { result } = renderHook(() => useGetStudents("acme", "cs50"), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.students).toEqual([])
  })

  it("treats a missing roster.csv (404) as the legitimate empty", async () => {
    responseStatus = 404
    const { result } = renderHook(() => useGetStudents("acme", "cs50"), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isError).toBe(false)
    expect(result.current.students).toEqual([])
  })

  it("parses roster rows on success without isError", async () => {
    responseBody = "username,role\nada,student\n"
    const { result } = renderHook(() => useGetStudents("acme", "cs50"), {
      wrapper,
    })
    await waitFor(() => expect(result.current.students).toHaveLength(1))
    expect(result.current.isError).toBe(false)
  })
})
