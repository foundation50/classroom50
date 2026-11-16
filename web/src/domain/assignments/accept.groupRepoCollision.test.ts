import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import type { Assignment } from "@/types/classroom"
import { localizedMessageOf } from "@/types/localizedMessage"
import { groupRepoName } from "@/util/studentRepo"
import { groupTeamName } from "@/util/teamSlug"
import { acceptAssignment } from "./accept"
import { AcceptStepError } from "./accessPrimitives"

const ORG = "cs50"
const CLASSROOM = "cs50"
const SLUG = "project"
const USER = "alice"
const REPO = groupRepoName(CLASSROOM, SLUG, 1)

const mocked = vi.hoisted(() => ({ assignment: undefined as unknown }))
vi.mock("../queries/assignments", async (importOriginal) => {
  const mod = await importOriginal<object>()
  return {
    ...mod,
    fetchAssignmentFromPages: vi.fn(async () => mocked.assignment),
  }
})

function apiError(status: number, message: string): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "test",
    message,
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

// A template-less, shim-less team assignment keeps the already-accepted path
// short (no setup commit, no Feedback PR), so the test is about the gate.
const TEAM_ENTRY: Assignment = {
  slug: SLUG,
  name: "Project",
  mode: "team",
  autograder: "default",
  max_group_size: 3,
  team_formation: "student",
  feedback_pr: false,
  no_autograder: true,
}

// Alice is on group team 1. The repo for counter 1 already exists; `visible`
// says whether she can read it at all, `push` whether she can push, and
// `attached` whether her team is attached to it.
function makeClient(opts: {
  visible: boolean
  push: boolean
  attached: boolean
}) {
  const requests: string[] = []
  const request = vi.fn(
    async (
      url: string,
      init?: { method?: string; body?: Record<string, unknown> },
    ) => {
      const method = init?.method ?? "GET"
      requests.push(`${method} ${url}`)
      if (method === "GET" && url === "/user") return { login: USER, id: 7 }
      if (url === `/user/memberships/orgs/${ORG}`) {
        return { state: "active", role: "admin" }
      }
      if (method === "GET" && url.startsWith("/user/teams")) {
        if (!url.includes("page=1")) return []
        return [
          {
            slug: await groupTeamName(CLASSROOM, SLUG, 1),
            id: 11,
            description: null,
            organization: { login: ORG },
          },
        ]
      }
      if (method === "POST" && url === `/orgs/${ORG}/repos`) {
        throw apiError(422, "name already exists on this account")
      }
      if (method === "GET" && url === `/repos/${ORG}/${REPO}`) {
        if (!opts.visible) throw apiError(404, "Not Found")
        return {
          name: REPO,
          full_name: `${ORG}/${REPO}`,
          default_branch: "main",
          html_url: `https://github.com/${ORG}/${REPO}`,
          ssh_url: `git@github.com:${ORG}/${REPO}.git`,
          private: false,
          permissions: { admin: false, push: opts.push, pull: true },
        }
      }
      if (
        method === "GET" &&
        url.includes(`/teams/`) &&
        url.includes(`/repos/`)
      ) {
        if (opts.attached) return undefined
        throw apiError(404, "Not Found")
      }
      if (
        method === "PUT" &&
        url.includes(`/teams/`) &&
        url.includes(`/repos/`)
      ) {
        return undefined
      }
      if (method === "PUT" && url.includes("/collaborators/")) return undefined
      throw new Error(`unexpected request: ${method} ${url}`)
    },
  )
  return { client: { request } as unknown as GitHubClient, requests }
}

const run = (client: GitHubClient) =>
  acceptAssignment({
    client,
    org: ORG,
    classroom: CLASSROOM,
    assignmentSlug: SLUG,
  })

// A deleted group's repo survives its team; if a new team is allocated the
// same counter, accept must not adopt (and attach the new team to) the old
// group's repo (#1128).
describe("acceptAssignment team mode against a leftover group repo", () => {
  it("fails closed when the existing repo is readable but not the group's", async () => {
    mocked.assignment = TEAM_ENTRY
    const { client, requests } = makeClient({
      visible: true,
      push: false,
      attached: false,
    })
    const err = await run(client).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AcceptStepError)
    expect((err as AcceptStepError).localized).toEqual({
      key: "accept.errors.teamRepoTaken",
      params: { org: ORG, repo: REPO },
    })
    // Nothing was granted on the old group's repo.
    expect(requests.some((r) => r.startsWith("PUT"))).toBe(false)
  })

  it("names the existing repo when the student can't even read it", async () => {
    mocked.assignment = TEAM_ENTRY
    const { client } = makeClient({
      visible: false,
      push: false,
      attached: false,
    })
    const err = await run(client).catch((e: unknown) => e)
    expect(localizedMessageOf(err)).toEqual({
      key: "accept.errors.repoExistsInaccessible",
      params: { org: ORG, repo: REPO },
    })
  })

  it("adopts the repo when the team is attached (a teammate accepted first)", async () => {
    mocked.assignment = TEAM_ENTRY
    const { client } = makeClient({
      visible: true,
      push: false,
      attached: true,
    })
    const result = await run(client)
    expect(result.status).toBe("already-accepted")
  })

  it("adopts the repo when the student can push (own half-finished accept)", async () => {
    mocked.assignment = TEAM_ENTRY
    const { client, requests } = makeClient({
      visible: true,
      push: true,
      attached: false,
    })
    const result = await run(client)
    expect(result.status).toBe("already-accepted")
    // The permission answered first; no attach probe was needed.
    expect(
      requests.some(
        (r) => r.startsWith("GET") && /\/teams\/.*\/repos\//.test(r),
      ),
    ).toBe(false)
  })
})
