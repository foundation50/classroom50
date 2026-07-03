import { describe, expect, it } from "vitest"

import {
  GitHubAPIError,
  isDefinitiveGitHubStatus,
  retryTransientNotFoundForbidden,
} from "./errors"

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/x",
    message: `HTTP ${status}`,
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

describe("isDefinitiveGitHubStatus", () => {
  it("treats 401 / 403 / 404 as definitive (no retry can change them)", () => {
    expect(isDefinitiveGitHubStatus(401)).toBe(true)
    expect(isDefinitiveGitHubStatus(403)).toBe(true)
    expect(isDefinitiveGitHubStatus(404)).toBe(true)
  })

  it("treats transient statuses (5xx / 429) as non-definitive", () => {
    expect(isDefinitiveGitHubStatus(429)).toBe(false)
    expect(isDefinitiveGitHubStatus(500)).toBe(false)
    expect(isDefinitiveGitHubStatus(502)).toBe(false)
    expect(isDefinitiveGitHubStatus(200)).toBe(false)
  })
})

describe("retryTransientNotFoundForbidden", () => {
  it("does not retry a definitive 404 / 403", () => {
    expect(retryTransientNotFoundForbidden(0, apiError(404))).toBe(false)
    expect(retryTransientNotFoundForbidden(0, apiError(403))).toBe(false)
  })

  it("retries transient failures up to a bounded count", () => {
    expect(retryTransientNotFoundForbidden(0, apiError(500))).toBe(true)
    expect(retryTransientNotFoundForbidden(1, apiError(500))).toBe(true)
    expect(retryTransientNotFoundForbidden(2, apiError(500))).toBe(false)
  })

  it("retries non-GitHubAPIError (network) failures within the bound", () => {
    expect(retryTransientNotFoundForbidden(0, new Error("network"))).toBe(true)
    expect(retryTransientNotFoundForbidden(2, new Error("network"))).toBe(false)
  })
})
