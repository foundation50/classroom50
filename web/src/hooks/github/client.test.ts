import { afterEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_REQUEST_TIMEOUT_MS, createGitHubClient } from "./client"

// Drive aborts with REAL short timeouts, not vitest fake timers: @sinonjs
// fake-timers doesn't mock AbortSignal.timeout, so advancing would never abort.

// Never settles until its signal aborts — the half-open connection to bound.
function stubHangingFetch(): void {
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    const signal = init?.signal
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("createGitHubClient request timeout", () => {
  it("aborts a hung request once the per-request timeout elapses", async () => {
    stubHangingFetch()
    const client = createGitHubClient({ token: "t" })

    // A tiny override exercises the real AbortSignal.timeout path fast.
    await expect(
      client.request("/rate_limit", { method: "GET", timeoutMs: 20 }),
    ).rejects.toThrow()
  })

  it("still aborts when the caller's own signal fires (composition)", async () => {
    stubHangingFetch()
    const client = createGitHubClient({ token: "t" })
    const controller = new AbortController()

    const pending = client.request("/rate_limit", {
      method: "GET",
      signal: controller.signal,
    })
    controller.abort()

    await expect(pending).rejects.toThrow()
  })

  it("does not abort when the default timeout is opted out with timeoutMs: 0", async () => {
    stubHangingFetch()
    const client = createGitHubClient({ token: "t" })

    let settled = false
    const pending = client
      .request("/rate_limit", { method: "GET", timeoutMs: 0 })
      .then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )

    // Opted out and no caller signal, so nothing aborts it.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)

    void pending
  })

  it("exposes a sane default timeout constant", () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(15000)
  })
})
