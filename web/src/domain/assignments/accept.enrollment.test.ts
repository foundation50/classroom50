import { describe, expect, it, vi } from "vitest"

import { assertEnrolledOrStaff } from "./accept"
import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"

// A 404 GitHubAPIError shaped like the real membership-read miss (isNotFound).
function notFound(path: string): GitHubAPIError {
  return new GitHubAPIError({
    status: 404,
    url: path,
    message: "Not Found",
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
}

function serverError(path: string): GitHubAPIError {
  return new GitHubAPIError({
    status: 500,
    url: path,
    message: "Server Error",
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
}

// Build a client whose team-membership reads succeed for `activeTeams`, 404 for
// everything else, and 500 for `transientTeams` (to exercise fail-open).
function makeClient(opts: {
  activeTeams?: string[]
  transientTeams?: string[]
}): GitHubClient {
  const active = new Set(opts.activeTeams ?? [])
  const transient = new Set(opts.transientTeams ?? [])
  const request = vi.fn(async (path: string) => {
    const match = /\/teams\/([^/]+)\/memberships\//.exec(path)
    const slug = match ? decodeURIComponent(match[1]) : ""
    if (transient.has(slug)) throw serverError(path)
    if (active.has(slug)) return { state: "active" }
    throw notFound(path)
  })
  return { request } as unknown as GitHubClient
}

describe("assertEnrolledOrStaff", () => {
  const org = "cs50"
  const classroom = "cs-fall"
  const user = "alice"
  const studentSlug = `classroom50-${classroom}`
  const taSlug = `classroom50-${classroom}-ta`

  it("passes for a student-team member", async () => {
    const client = makeClient({ activeTeams: [studentSlug] })
    await expect(
      assertEnrolledOrStaff(client, org, classroom, user),
    ).resolves.toBeUndefined()
  })

  it("passes for a staff-team member (bypass)", async () => {
    const client = makeClient({ activeTeams: [taSlug] })
    await expect(
      assertEnrolledOrStaff(client, org, classroom, user),
    ).resolves.toBeUndefined()
  })

  it("throws a localized notEnrolled error for a non-member (all definitive 404)", async () => {
    const client = makeClient({ activeTeams: [] })
    await expect(
      assertEnrolledOrStaff(client, org, classroom, user),
    ).rejects.toMatchObject({
      localized: { key: "accept.notEnrolled.error" },
    })
  })

  it("fails open: a transient (non-404) read propagates instead of blocking", async () => {
    const client = makeClient({ transientTeams: [studentSlug] })
    await expect(
      assertEnrolledOrStaff(client, org, classroom, user),
    ).rejects.toBeInstanceOf(GitHubAPIError)
  })

  it("a definitive member resolves even when a sibling probe errors transiently", async () => {
    // Regression: a parallel probe set must not let an unrelated transient
    // failure block an enrolled student. Student-team member + a 500 on the
    // staff probe must still resolve (enrolled wins over the sibling blip).
    const client = makeClient({
      activeTeams: [studentSlug],
      transientTeams: [taSlug],
    })
    await expect(
      assertEnrolledOrStaff(client, org, classroom, user),
    ).resolves.toBeUndefined()
  })
})
