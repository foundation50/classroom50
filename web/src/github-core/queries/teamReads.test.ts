import { describe, expect, it } from "vitest"

import { getTeamMembershipState } from "./teamReads"
import { GitHubAPIError } from "../errors"
import type { GitHubClient } from "../client"

const rateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const apiError = (status: number) =>
  new GitHubAPIError({
    status,
    url: "/orgs/acme/teams/classroom50-cs101/memberships/ada",
    message: `http ${status}`,
    body: {},
    rateLimit,
  })

const clientWith = (impl: (path: string) => Promise<unknown>): GitHubClient =>
  ({ request: impl }) as unknown as GitHubClient

// The invite reconcile's irreversible team delete rests on this exact
// contract: 404 is the only "not a member" — every other failure must
// propagate so a transient blip is never read as unenrollment.
describe("getTeamMembershipState", () => {
  it("resolves the membership state for active and pending records", async () => {
    await expect(
      getTeamMembershipState(
        clientWith(async () => ({ state: "active" })),
        "acme",
        "classroom50-cs101",
        "ada",
      ),
    ).resolves.toBe("active")
    await expect(
      getTeamMembershipState(
        clientWith(async () => ({ state: "pending" })),
        "acme",
        "classroom50-cs101",
        "ada",
      ),
    ).resolves.toBe("pending")
  })

  it("treats a record with no state field as a membership (active)", async () => {
    await expect(
      getTeamMembershipState(
        clientWith(async () => ({})),
        "acme",
        "classroom50-cs101",
        "ada",
      ),
    ).resolves.toBe("active")
  })

  it("resolves null on 404 — the one authoritative 'not on this team'", async () => {
    await expect(
      getTeamMembershipState(
        clientWith(async () => {
          throw apiError(404)
        }),
        "acme",
        "classroom50-cs101",
        "ada",
      ),
    ).resolves.toBeNull()
  })

  it("propagates every non-404 error instead of reading it as absence", async () => {
    for (const status of [500, 502, 403, 429]) {
      await expect(
        getTeamMembershipState(
          clientWith(async () => {
            throw apiError(status)
          }),
          "acme",
          "classroom50-cs101",
          "ada",
        ),
      ).rejects.toMatchObject({ status })
    }
  })

  it("escapes org, slug, and username in the request path", async () => {
    let requested = ""
    await getTeamMembershipState(
      clientWith(async (path) => {
        requested = path
        return { state: "active" }
      }),
      "acme",
      "classroom50-cs101",
      "ada lovelace",
    )
    expect(requested).toBe(
      "/orgs/acme/teams/classroom50-cs101/memberships/ada%20lovelace",
    )
  })
})
