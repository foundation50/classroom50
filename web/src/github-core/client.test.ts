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

describe("createGitHubClient request logging", () => {
  function stubJsonFetch(status = 200, body: unknown = { ok: true }): void {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
  }

  it("logs request + response debug lines with method/path, never the token", async () => {
    stubJsonFetch()
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    const client = createGitHubClient({ token: "super-secret-token" })

    await client.request("/rate_limit", { method: "GET" })

    const lines = debug.mock.calls.map((c) => String(c[0]))
    // A scoped request line and a scoped response line both fire.
    expect(lines.some((l) => /\[github:client\].*request\b/.test(l))).toBe(true)
    expect(lines.some((l) => /\[github:client\].*response\b/.test(l))).toBe(
      true,
    )
    // The token must never appear in any logged line OR its context arg.
    const serialized = JSON.stringify(debug.mock.calls)
    expect(serialized).not.toContain("super-secret-token")

    debug.mockRestore()
  })

  it("logs an api-error debug line (status/path, no body) on a failed response", async () => {
    stubJsonFetch(404, { message: "Not Found", secret: "should-not-log" })
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    const client = createGitHubClient({ token: "t" })

    await expect(
      client.request("/missing", { method: "GET" }),
    ).rejects.toThrow()

    const apiError = debug.mock.calls.find((c) =>
      /\[github:client\].*api error/.test(String(c[0])),
    )
    expect(apiError).toBeTruthy()
    // The status is in the context; the raw body's non-message fields are not.
    expect(JSON.stringify(apiError)).toContain("404")
    // The raw response body must not appear in ANY logged call — not just the
    // scrubbed `api error` line. Guards against a stray site logging `{ body }`.
    expect(JSON.stringify(debug.mock.calls)).not.toContain("should-not-log")

    debug.mockRestore()
  })
})
