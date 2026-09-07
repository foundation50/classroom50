// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

const copyAssignment =
  vi.fn<(client: unknown, input: { targetSlug: string }) => Promise<unknown>>()
vi.mock("@/domain/assignments", () => ({
  copyAssignmentWithConflictRetry: (client: unknown, input: never) =>
    copyAssignment(client, input),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useCanAttemptTemplateGrant: () => true,
}))

import { useReuseAssignment } from "./useReuseAssignment"
import type { Assignment } from "@/types/classroom"

const source = { slug: "hw1", name: "Homework 1" } as Assignment

// The slug state is derived through the shared planner (util/bulkReuseSlugs);
// these pin what the single-assignment modals read off the hook.
function setup(over: Partial<Parameters<typeof useReuseAssignment>[0]> = {}) {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  const closeDialog = vi.fn()
  const hook = renderHook(
    () =>
      useReuseAssignment({
        org: "acme",
        targetClassroom: "cs102",
        source,
        takenSlugs: ["hw1"],
        reservedSlugs: ["old-hw3"],
        takenLoading: false,
        closeDialog,
        ...over,
      }),
    { wrapper },
  )
  return { ...hook, closeDialog }
}

beforeEach(() => {
  copyAssignment.mockReset().mockResolvedValue({})
})

describe("useReuseAssignment", () => {
  it("defaults to the next free slug in the target", () => {
    const { result } = setup()
    expect(result.current.displayedSlug).toBe("hw1-2")
    expect(result.current.normalizedSlug).toBe("hw1-2")
    expect(result.current.canSubmit).toBe(true)
  })

  it("blocks a typed slug that is taken, case-insensitively", () => {
    const { result } = setup()
    act(() => result.current.onSlugChange("HW1"))
    expect(result.current.slugTaken).toBe(true)
    expect(result.current.canSubmit).toBe(false)
  })

  it("blocks a typed slug a renamed assignment still reserves", () => {
    const { result } = setup()
    act(() => result.current.onSlugChange("old-hw3"))
    expect(result.current.slugReserved).toBe(true)
    expect(result.current.canSubmit).toBe(false)
  })

  it("blocks a typed slug over the target's repo-name budget", () => {
    const { result } = setup()
    act(() => result.current.onSlugChange("x".repeat(60)))
    expect(result.current.slugOverBudget).toBe(true)
    expect(result.current.canSubmit).toBe(false)
  })

  it("shows the raw text while typing and normalizes on blur", () => {
    const { result } = setup()
    act(() => result.current.onSlugChange("Hausaufgabe Zwei"))
    expect(result.current.displayedSlug).toBe("Hausaufgabe Zwei")
    expect(result.current.normalizedSlug).toBe("hausaufgabe-zwei")
    act(() => result.current.onSlugBlur())
    expect(result.current.displayedSlug).toBe("hausaufgabe-zwei")
  })

  it("re-arms the default after resetSlug", () => {
    const { result } = setup()
    act(() => result.current.onSlugChange("custom"))
    act(() => result.current.resetSlug())
    expect(result.current.displayedSlug).toBe("hw1-2")
    expect(result.current.slugTouched).toBe(false)
  })

  it("copies under the normalized slug and closes on a clean result", async () => {
    const { result, closeDialog } = setup()
    act(() => result.current.onSlugChange("Homework One"))
    act(() => result.current.submit())

    await waitFor(() => expect(closeDialog).toHaveBeenCalled())
    expect(copyAssignment.mock.calls[0][1].targetSlug).toBe("homework-one")
  })

  it("keeps the dialog open with the grant warning", async () => {
    copyAssignment.mockResolvedValue({ templateGrantWarning: "owner required" })
    const { result, closeDialog } = setup()
    act(() => result.current.submit())

    await waitFor(() => expect(result.current.warning).toBe("owner required"))
    expect(closeDialog).not.toHaveBeenCalled()
  })
})
