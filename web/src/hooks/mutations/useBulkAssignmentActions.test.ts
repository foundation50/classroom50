// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

// Held open so a second run() can be attempted while the first is in flight.
// The loop itself is tested in domain/assignments/bulkActions.test.ts.
let release: (() => void) | null = null
type CopyInput = { shouldContinue?: () => boolean }
let lastInput: CopyInput | null = null
const bulkCopy = vi.fn(
  (input: CopyInput) =>
    new Promise<[]>((resolve) => {
      lastInput = input
      release = () => resolve([])
    }),
)
vi.mock("@/domain/assignments", () => ({
  bulkCopyAssignments: (_client: unknown, input: CopyInput) => bulkCopy(input),
  deleteAssignmentsWithConflictRetry: vi.fn(),
  setAssignmentsLockWithConflictRetry: vi.fn(),
}))

vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useCanAttemptTemplateGrant: () => false,
}))

import { useBulkReuseAssignments } from "./useBulkAssignmentActions"
import type { Assignment } from "@/types/classroom"

const items = [{ source: { slug: "hw1" } as Assignment, targetSlug: "hw1-2" }]

function setup() {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return renderHook(() => useBulkReuseAssignments("acme"), { wrapper })
}

describe("useBulkReuseAssignments", () => {
  it("ignores a second run while one is in flight", async () => {
    const { result } = setup()

    // Both calls land before `running` can reach a re-render, like a
    // double-click.
    const first = result.current.run(items, "cs101")
    const second = result.current.run(items, "cs101")

    await second
    expect(bulkCopy).toHaveBeenCalledTimes(1)

    release?.()
    await first
    await waitFor(() => expect(result.current.running).toBe(false))

    const third = result.current.run(items, "cs101")
    release?.()
    await third
    expect(bulkCopy).toHaveBeenCalledTimes(2)
  })

  // The bar owns the run; once it unmounts nothing can report the result, so
  // the loop is told to defer what is left rather than finish headless.
  it("tells the loop to stop once its owner unmounts", async () => {
    const { result, unmount } = setup()

    const run = result.current.run(items, "cs101")
    expect(lastInput?.shouldContinue?.()).toBe(true)

    unmount()
    expect(lastInput?.shouldContinue?.()).toBe(false)

    release?.()
    await run
  })

  it("resets to idle only when no run is in flight", async () => {
    const { result } = setup()

    const run = result.current.run(items, "cs101")
    await waitFor(() => expect(result.current.total).toBe(1))
    result.current.reset()
    expect(result.current.total).toBe(1)

    release?.()
    await run
    await waitFor(() => expect(result.current.running).toBe(false))
    result.current.reset()
    await waitFor(() => expect(result.current.total).toBe(0))
  })
})
