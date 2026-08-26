// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

// Held open so a second run() can be attempted while the first is in flight —
// the double-click the latch exists for. The loop itself is the domain's, and
// tested there (domain/assignments/bulkActions.test.ts).
let release: (() => void) | null = null
const bulkCopy = vi.fn(
  () =>
    new Promise<[]>((resolve) => {
      release = () => resolve([])
    }),
)
vi.mock("@/domain/assignments", () => ({
  bulkCopyAssignments: () => bulkCopy(),
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

    // Both calls happen before `running` can reach a re-render, exactly as a
    // double-click on the modal's Reuse button would.
    const first = result.current.run(items, "cs101")
    const second = result.current.run(items, "cs101")

    await second
    expect(bulkCopy).toHaveBeenCalledTimes(1)

    release?.()
    await first
    await waitFor(() => expect(result.current.running).toBe(false))

    // The latch releases with the run: a later click still works.
    const third = result.current.run(items, "cs101")
    release?.()
    await third
    expect(bulkCopy).toHaveBeenCalledTimes(2)
  })
})
