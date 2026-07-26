// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"

const getOrgActionsMode = vi.fn()
const optionalClient = vi.fn()
const isOrgOwner = vi.fn()

vi.mock("@/github-core/mutations", () => ({
  getOrgActionsMode: (...args: unknown[]) => getOrgActionsMode(...args),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useOptionalGitHubClient: () => optionalClient(),
}))
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useIsOrgOwner: () => isOrgOwner(),
}))

import useFeedbackPrWarning from "./useFeedbackPrWarning"
import type {
  FeedbackPrSubject,
  FeedbackPrWarning,
} from "./useFeedbackPrWarning"

afterEach(() => {
  vi.clearAllMocks()
})

const OWNER = {
  isOwner: true,
  isPending: false,
  isError: false,
  retry: () => {},
}
const NON_OWNER = {
  isOwner: false,
  isPending: false,
  isError: false,
  retry: () => {},
}
const CLIENT = { request: vi.fn(), requestRaw: vi.fn() }

// The assignment opts into the Feedback PR — the subject case that can warn.
const WANTS: FeedbackPrSubject = { feedback_pr: true, empty_repo: false }

// Retries off so a rejected read settles immediately instead of backing off.
const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function setup({
  mode = "active",
  owner = OWNER,
  client = CLIENT as unknown,
}: { mode?: string; owner?: typeof OWNER; client?: unknown } = {}) {
  isOrgOwner.mockReturnValue(owner)
  optionalClient.mockReturnValue(client)
  getOrgActionsMode.mockResolvedValue(mode)
}

// Settles the query before asserting, so a `show: false` assertion can't pass
// merely because the read was still in flight.
async function verdict(
  // No default: a destructuring/parameter default fires on an explicit
  // `undefined`, which would silently substitute an org and never exercise the
  // no-org path.
  org: string | undefined,
  subject: FeedbackPrSubject = WANTS,
): Promise<FeedbackPrWarning> {
  const { result } = renderHook(() => useFeedbackPrWarning(org, subject), {
    wrapper,
  })
  // One microtask-plus tick is enough for an already-resolved queryFn to land.
  await waitFor(() => expect(result.current).toBeDefined())
  return result.current
}

describe("useFeedbackPrWarning", () => {
  it("warns when the org is paused", async () => {
    setup({ mode: "paused" })
    const { result } = renderHook(() => useFeedbackPrWarning("acme", WANTS), {
      wrapper,
    })
    await waitFor(() =>
      expect(result.current).toEqual({ show: true, reason: "paused" }),
    )
  })

  it("warns when org Actions are disabled entirely", async () => {
    setup({ mode: "disabled" })
    const { result } = renderHook(() => useFeedbackPrWarning("acme", WANTS), {
      wrapper,
    })
    await waitFor(() =>
      expect(result.current).toEqual({ show: true, reason: "disabled" }),
    )
  })

  it("stays silent when autograding is active", async () => {
    setup({ mode: "active" })
    expect(await verdict("acme")).toEqual({ show: false })
  })

  // Fails open. A read we could not perform must never produce a red warning:
  // getOrgActionsMode swallows a 403/5xx to "unknown", so warning here would
  // fire on every org whose policy we cannot see.
  it("stays silent when the mode is unknown", async () => {
    setup({ mode: "unknown" })
    expect(await verdict("acme")).toEqual({ show: false })
  })

  it("stays silent on the very first render, before the read settles", () => {
    setup({ mode: "paused" })
    const { result } = renderHook(() => useFeedbackPrWarning("acme", WANTS), {
      wrapper,
    })
    expect(result.current).toEqual({ show: false })
  })

  // The endpoint is admin-only, so a non-owner has no readable signal at all.
  it("stays silent for a non-owner viewer, and issues no request", async () => {
    setup({ mode: "paused", owner: NON_OWNER })
    expect(await verdict("acme")).toEqual({ show: false })
    expect(getOrgActionsMode).not.toHaveBeenCalled()
  })

  // The form also renders where GitHub auth isn't ready. An advisory warning
  // must never break the form it annotates.
  it("stays silent with no GitHub client, and issues no request", async () => {
    setup({ mode: "paused", client: null })
    expect(await verdict("acme")).toEqual({ show: false })
    expect(getOrgActionsMode).not.toHaveBeenCalled()
  })

  // Subject config, not environment: an assignment that never wanted the
  // Feedback PR must not be warned about it.
  it("stays silent when the assignment has feedback_pr off", async () => {
    setup({ mode: "paused" })
    expect(
      await verdict("acme", { feedback_pr: false, empty_repo: false }),
    ).toEqual({ show: false })
    expect(getOrgActionsMode).not.toHaveBeenCalled()
  })

  // An absent flag reads as false on the wire (the CLI omits it), so it must be
  // treated the same as an explicit false.
  it("stays silent when feedback_pr is absent", async () => {
    setup({ mode: "paused" })
    expect(await verdict("acme", {})).toEqual({ show: false })
    expect(getOrgActionsMode).not.toHaveBeenCalled()
  })

  // An empty repo has no baseline commit, so the Feedback PR is structurally
  // off regardless of the org's Actions policy.
  it("stays silent for an empty-repo assignment", async () => {
    setup({ mode: "paused" })
    expect(
      await verdict("acme", { feedback_pr: true, empty_repo: true }),
    ).toEqual({ show: false })
    expect(getOrgActionsMode).not.toHaveBeenCalled()
  })

  it("stays silent without an org, and issues no request", async () => {
    setup({ mode: "paused" })
    getOrgActionsMode.mockClear()
    expect(await verdict(undefined)).toEqual({ show: false })
    expect(getOrgActionsMode).not.toHaveBeenCalled()
  })
})
