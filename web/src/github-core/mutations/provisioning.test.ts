import { describe, expect, it } from "vitest"

import { GitHubAPIError } from "@/github-core/errors"
import { isNonFastForward } from "./provisioning"

const emptyRateLimit = {
  limit: null,
  remaining: null,
  reset: null,
  used: null,
  resource: null,
  retryAfter: null,
}

const err = (status: number, message: string, body?: unknown) =>
  new GitHubAPIError({
    status,
    url: "u",
    message,
    body: body ?? { message },
    rateLimit: emptyRateLimit,
  })

describe("isNonFastForward", () => {
  it("matches the classic non-fast-forward 422", () => {
    expect(isNonFastForward(err(422, "Update is not a fast forward"))).toBe(
      true,
    )
  })

  it("matches GitHub's 'Reference cannot be updated' 422 (lost ref race)", () => {
    expect(isNonFastForward(err(422, "Reference cannot be updated"))).toBe(true)
  })

  it("matches when the reason is only in an object body.message", () => {
    expect(
      isNonFastForward(
        new GitHubAPIError({
          status: 422,
          url: "u",
          message: "Validation Failed",
          body: { message: "Reference cannot be updated" },
          rateLimit: emptyRateLimit,
        }),
      ),
    ).toBe(true)
  })

  it("ignores unrelated 422s", () => {
    expect(isNonFastForward(err(422, "Validation Failed"))).toBe(false)
  })

  it("ignores non-422 statuses", () => {
    expect(isNonFastForward(err(409, "Reference cannot be updated"))).toBe(
      false,
    )
  })

  it("ignores non-GitHub errors", () => {
    expect(isNonFastForward(new Error("Reference cannot be updated"))).toBe(
      false,
    )
  })
})
