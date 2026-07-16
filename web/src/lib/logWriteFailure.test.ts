import { describe, expect, it, vi } from "vitest"

import { logWriteFailure } from "./logWriteFailure"
import { GitHubAPIError } from "@/github-core/errors"
import type { Logger } from "@/lib/logger"

function fakeLogger() {
  const error = vi.fn()
  const log = { error } as unknown as Logger
  return { log, error }
}

describe("logWriteFailure", () => {
  it("logs a GitHubAPIError's status + requestId under the given message (no record)", () => {
    const { log, error } = fakeLogger()
    const err = new GitHubAPIError({
      status: 422,
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
      requestId: "req-9",
    })

    logWriteFailure(log, err, "create classroom failed")

    expect(error).toHaveBeenCalledWith("create classroom failed", {
      status: 422,
      requestId: "req-9",
    })
    expect(error).toHaveBeenCalledWith(
      "create classroom failed",
      expect.not.objectContaining({ record: true }),
    )
  })

  it("records a non-GitHub error under a generic message", () => {
    const { log, error } = fakeLogger()
    const err = new Error("network down")

    logWriteFailure(log, err, "create assignment failed")

    expect(error).toHaveBeenCalledWith("non-GitHub API error", {
      err,
      record: true,
    })
  })
})
