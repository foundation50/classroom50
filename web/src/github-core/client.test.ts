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

describe("createGitHubClient non-JSON response (GitHub-outage shape)", () => {
  function stubTextFetch(status: number, body: string): void {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(body, {
          status,
          headers: { "content-type": "text/html" },
        }),
      ),
    )
  }

  // A 5xx-with-HTML already flows through the non-OK branch as a GitHubAPIError
  // carrying the real status, so isDefiniteOutageError classifies it (>= 500).
  it("throws a 5xx GitHubAPIError when a failed response carries an HTML body", async () => {
    stubTextFetch(503, "<html><body>Service Unavailable</body></html>")
    const client = createGitHubClient({ token: "t" })

    await expect(
      client.request("/rate_limit", { method: "GET" }),
    ).rejects.toMatchObject({ name: "GitHubAPIError", status: 503 })
  })

  // The gap this closes: a 200 whose body is HTML (edge served a page without
  // reaching GitHub's app layer) must not leak a raw JSON SyntaxError. It's
  // remapped to a synthetic 502 GitHubAPIError so it reads as an outage.
  it("remaps a 200 with an HTML body to a synthetic 5xx instead of a SyntaxError", async () => {
    stubTextFetch(200, "<!DOCTYPE html><html><body>proxy error</body></html>")
    const client = createGitHubClient({ token: "t" })

    const err = await client.request("/rate_limit", { method: "GET" }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe("GitHubAPIError")
    expect((err as { status: number }).status).toBe(502)
    // Never leak the parser's raw message or the HTML body.
    expect((err as Error).message).not.toMatch(/Unexpected token/i)
    expect((err as Error).message).not.toContain("proxy error")
  })

  it("still returns parsed JSON on a normal 200", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ hello: "world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
    const client = createGitHubClient({ token: "t" })

    await expect(
      client.request<{ hello: string }>("/x", { method: "GET" }),
    ).resolves.toEqual({ hello: "world" })
  })

  // The synthetic 502 keeps X-GitHub-Request-Id (non-sensitive) so a real edge
  // outage stays correlatable in support/audit, matching the non-OK branch.
  it("preserves X-GitHub-Request-Id on the synthetic 502", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response("<html><body>proxy error</body></html>", {
          status: 200,
          headers: {
            "content-type": "text/html",
            "x-github-request-id": "ABCD:1234:EF",
          },
        }),
      ),
    )
    const client = createGitHubClient({ token: "t" })

    const err = await client.request("/rate_limit", { method: "GET" }).then(
      () => null,
      (e: unknown) => e,
    )

    expect((err as { status: number }).status).toBe(502)
    expect((err as { requestId: string | null }).requestId).toBe("ABCD:1234:EF")
    // The raw HTML body is still dropped.
    expect((err as Error).message).not.toContain("proxy error")
  })
})
