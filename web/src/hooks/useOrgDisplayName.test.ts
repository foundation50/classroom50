// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

const request = vi.fn()
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))

import useOrgDisplayName from "./useOrgDisplayName"

function setup(login?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return renderHook(() => useOrgDisplayName(login), { wrapper })
}

beforeEach(() => {
  request.mockReset()
})

describe("useOrgDisplayName", () => {
  it("returns the org's display name from GET /orgs/{login}", async () => {
    request.mockResolvedValue({
      login: "classroom50-summer-dev",
      id: 1,
      name: "Classroom 50 Summer Dev",
    })
    const { result } = setup("classroom50-summer-dev")
    await waitFor(() => expect(result.current).toBe("Classroom 50 Summer Dev"))
    expect(request).toHaveBeenCalledWith("/orgs/classroom50-summer-dev")
  })

  it("returns undefined when the org has no display name", async () => {
    request.mockResolvedValue({ login: "acme", id: 2, name: null })
    const { result } = setup("acme")
    // The query resolves but yields no usable name; caller falls back to login.
    await waitFor(() => expect(request).toHaveBeenCalled())
    expect(result.current).toBeUndefined()
  })

  it("does not fetch when no login is given", () => {
    const { result } = setup(undefined)
    expect(result.current).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })
})
