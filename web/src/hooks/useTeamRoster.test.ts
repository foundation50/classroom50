import { describe, expect, it } from "vitest"
import { computePendingHidden, isForbiddenError } from "./useTeamRoster"
import { GitHubAPIError } from "./github/errors"

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "https://api.github.com/orgs/acme/teams/classroom50-cs101-ta/invitations",
    message: status === 403 ? "Forbidden" : `boom ${status}`,
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

describe("isForbiddenError", () => {
  it("is true only for a 403 GitHubAPIError", () => {
    expect(isForbiddenError(apiError(403))).toBe(true)
    expect(isForbiddenError(apiError(404))).toBe(false)
    expect(isForbiddenError(new Error("nope"))).toBe(false)
    expect(isForbiddenError(null)).toBe(false)
  })
})

describe("computePendingHidden", () => {
  it("hides when org invitations are forbidden", () => {
    expect(computePendingHidden(true, [])).toBe(true)
  })

  it("hides when any staff-team invite fetch is forbidden", () => {
    expect(computePendingHidden(false, [apiError(403), undefined])).toBe(true)
    expect(computePendingHidden(false, [undefined, apiError(403)])).toBe(true)
  })

  it("does NOT hide on a 404 (uncreated staff team)", () => {
    expect(computePendingHidden(false, [apiError(404), apiError(404)])).toBe(
      false,
    )
  })

  it("does NOT hide when nothing is forbidden", () => {
    expect(computePendingHidden(false, [undefined, undefined])).toBe(false)
  })
})
