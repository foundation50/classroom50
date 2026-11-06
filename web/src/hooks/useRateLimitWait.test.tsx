// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

import {
  GitHubAPIError,
  retryDelayForGitHubError,
  retryTransientGitHubError,
} from "@/github-core/errors"
import { useRateLimitWait } from "./useRateLimitWait"

const throttled = () =>
  new GitHubAPIError({
    status: 403,
    url: "https://api.github.com/x",
    message: "rate limited",
    body: null,
    rateLimit: {
      limit: 5000,
      remaining: 0,
      used: 5000,
      reset: null,
      resource: "core",
      retryAfter: 7,
    },
  })

function setup() {
  // The app's QueryClient policy: shared retry predicate and delay.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: retryTransientGitHubError,
        retryDelay: retryDelayForGitHubError,
      },
    },
  })
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(QueryClientProvider, { client: queryClient }, children)
  return { queryClient, ...renderHook(() => useRateLimitWait(), { wrapper }) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("useRateLimitWait", () => {
  it("is null while nothing is waiting on a rate limit", () => {
    const { result } = setup()
    expect(result.current).toBeNull()
  })

  it("counts down to the retry a rate-limited query scheduled, then clears", async () => {
    vi.useFakeTimers()
    const { queryClient, result } = setup()
    let calls = 0
    const fetching = queryClient
      .fetchQuery({
        queryKey: ["gated-read"],
        queryFn: async () => {
          calls += 1
          if (calls === 1) throw throttled()
          return "ok"
        },
      })
      .catch(() => undefined)

    // The first failure schedules a retry Retry-After (7s) out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current).toBe(7)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(result.current).toBe(4)

    // The retry fires and succeeds; nothing is waiting any more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(calls).toBe(2)
    expect(result.current).toBeNull()
    await fetching
  })

  it("ignores failures that are not rate limits", async () => {
    const { queryClient, result } = setup()
    await queryClient
      .fetchQuery({
        queryKey: ["plain-500"],
        queryFn: async () => {
          throw new GitHubAPIError({
            status: 500,
            url: "https://api.github.com/x",
            message: "boom",
            body: null,
            rateLimit: {
              limit: null,
              remaining: null,
              used: null,
              reset: null,
              resource: null,
              retryAfter: null,
            },
          })
        },
        retry: false,
      })
      .catch(() => undefined)
    expect(result.current).toBeNull()
  })
})
