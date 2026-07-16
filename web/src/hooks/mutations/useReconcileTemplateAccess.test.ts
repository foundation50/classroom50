// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

const tryGrantTeamTemplateRead =
  vi.fn<(...args: unknown[]) => Promise<string | undefined>>()

vi.mock("@/domain/assignments", () => ({
  tryGrantTeamTemplateRead: (...args: unknown[]) =>
    tryGrantTeamTemplateRead(...args),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))

import { useReconcileTemplateAccess } from "./useReconcileTemplateAccess"

const ORG = "cs50"
const CLASSROOM = "cs50"
const SLUG = "hw1"
const TEMPLATE = { owner: ORG, repo: "tmpl", branch: "main" }
const KEY = [
  "template-team-access",
  ORG,
  CLASSROOM,
  TEMPLATE.owner,
  TEMPLATE.repo,
]

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
}

function freshClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useReconcileTemplateAccess", () => {
  it("seeds the team-access cache true on a clean grant (avoids a stale refetch)", async () => {
    tryGrantTeamTemplateRead.mockResolvedValue(undefined)
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useReconcileTemplateAccess(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      template: TEMPLATE,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual({ warning: undefined })
    expect(queryClient.getQueryData(KEY)).toBe(true)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("invalidates (does not seed true) when the grant returns a warning", async () => {
    tryGrantTeamTemplateRead.mockResolvedValue("student grant failed")
    const queryClient = freshClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { result } = renderHook(() => useReconcileTemplateAccess(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      template: TEMPLATE,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual({ warning: "student grant failed" })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY })
    expect(queryClient.getQueryData(KEY)).toBeUndefined()
  })

  it("passes org/classroom/slug/template through to the domain grant", async () => {
    tryGrantTeamTemplateRead.mockResolvedValue(undefined)
    const queryClient = freshClient()
    const { result } = renderHook(() => useReconcileTemplateAccess(), {
      wrapper: wrapperWith(queryClient),
    })

    result.current.mutate({
      org: ORG,
      classroom: CLASSROOM,
      slug: SLUG,
      template: TEMPLATE,
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(tryGrantTeamTemplateRead).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      CLASSROOM,
      SLUG,
      TEMPLATE,
    )
  })
})
