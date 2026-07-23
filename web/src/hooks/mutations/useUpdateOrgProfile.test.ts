// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import { githubKeys } from "@/github-core/queries"

const request = vi.fn()
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request }),
}))

import { useUpdateOrgProfile } from "./useUpdateOrgProfile"

const ORG = "acme"

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const { result } = renderHook(() => useUpdateOrgProfile(ORG), { wrapper })
  return { queryClient, result }
}

beforeEach(() => request.mockReset())

describe("useUpdateOrgProfile", () => {
  it("PATCHes /orgs/{org} and seeds the returned org into the details cache", async () => {
    const updated = { login: ORG, id: 1, name: "Acme Inc" }
    request.mockResolvedValue(updated)
    const { queryClient, result } = setup()

    result.current.mutate({ name: "Acme Inc" })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(request).toHaveBeenCalledWith("/orgs/acme", {
      method: "PATCH",
      body: { name: "Acme Inc" },
    })
    expect(queryClient.getQueryData(githubKeys.orgDetails(ORG))).toEqual(
      updated,
    )
  })

  it("surfaces the error when the write fails", async () => {
    request.mockRejectedValueOnce(new Error("403 Forbidden"))
    const { result } = setup()

    result.current.mutate({ name: "x" })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toContain("403")
  })
})
