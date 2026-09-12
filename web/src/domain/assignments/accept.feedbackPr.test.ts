import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import type { Assignment } from "@/types/classroom"
import { acceptAssignment } from "./accept"
import { feedbackPrBody } from "./feedbackPr"
import { studentRepoName } from "@/util/studentRepo"

const ORG = "cs50"
const CLASSROOM = "cs50"
const SLUG = "hw1"
const USER = "alice"
const REPO = studentRepoName(CLASSROOM, SLUG, USER)
const RELEASE_URL = `https://github.com/${ORG}/${REPO}/releases/latest`

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

const BASE_ENTRY: Assignment = {
  slug: SLUG,
  name: "Homework 1",
  mode: "individual",
  autograder: "default",
  feedback_pr: true,
  template: { owner: ORG, repo: "hw1-starter", branch: "main" },
}

// Route-table client for the healthy re-accept path (repo exists, marker
// present): no setup commit runs, so the Feedback PR step is the only write.
// Captures the PR-create body.
function makeClient() {
  let prBody: Record<string, string> | undefined
  const request = vi.fn(
    async (
      url: string,
      init?: { method?: string; body?: Record<string, unknown> },
    ) => {
      const method = init?.method ?? "GET"
      if (method === "GET" && url === "/user") return { login: USER, id: 7 }
      if (url === `/user/memberships/orgs/${ORG}`) {
        return { state: "active", role: "admin" }
      }
      if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      if (
        method === "POST" &&
        (url === `/orgs/${ORG}/repos` ||
          url === `/repos/${ORG}/hw1-starter/generate`)
      ) {
        throw apiError(422, "name already exists on this account")
      }
      if (method === "GET" && url === `/repos/${ORG}/${REPO}`) {
        return {
          name: REPO,
          full_name: `${ORG}/${REPO}`,
          default_branch: "main",
          html_url: `https://github.com/${ORG}/${REPO}`,
          ssh_url: `git@github.com:${ORG}/${REPO}.git`,
          private: true,
        }
      }
      if (method === "GET" && url.includes(`/repos/${ORG}/${REPO}/contents/`)) {
        return { type: "file" }
      }
      if (method === "GET" && url.startsWith(`/repos/${ORG}/${REPO}/commits`)) {
        return [{ sha: "accept-sha" }]
      }
      if (method === "GET" && url.startsWith(`/repos/${ORG}/${REPO}/pulls`)) {
        return []
      }
      if (method === "POST" && url === `/repos/${ORG}/${REPO}/git/refs`) {
        return { ref: "refs/heads/feedback", object: { sha: "accept-sha" } }
      }
      if (method === "POST" && url === `/repos/${ORG}/${REPO}/pulls`) {
        prBody = init?.body as Record<string, string>
        return {
          number: 1,
          html_url: `https://github.com/${ORG}/${REPO}/pull/1`,
        }
      }
      if (method === "POST" && url.includes(`/repos/${ORG}/${REPO}/labels`)) {
        return {}
      }
      if (method === "POST" && url.includes(`/issues/1/labels`)) return []
      if (method === "PUT" && url.includes("/collaborators/")) return undefined
      throw new Error(`unexpected request: ${method} ${url}`)
    },
  )
  return {
    client: { request } as unknown as GitHubClient,
    prBody: () => prBody,
  }
}

// Discussion #964: the accept flow, not just the domain function, must hand
// the Feedback PR step the assignment's autograding state.
describe("acceptAssignment Feedback PR body", () => {
  it("posts the trimmed body for a no_autograder assignment", async () => {
    mocked.assignment = { ...BASE_ENTRY, no_autograder: true }
    const { client, prBody } = makeClient()
    const result = await acceptAssignment({
      client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
    })
    expect(result.status).toBe("already-accepted")
    const body = prBody()?.body
    expect(body).toBe(feedbackPrBody("main", RELEASE_URL, false))
    expect(body).not.toMatch(/autograd/i)
  })

  it("posts the autograded body for an ordinary assignment", async () => {
    mocked.assignment = BASE_ENTRY
    const { client, prBody } = makeClient()
    await acceptAssignment({
      client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
    })
    expect(prBody()?.body).toBe(feedbackPrBody("main", RELEASE_URL, true))
    expect(prBody()?.body).toContain(RELEASE_URL)
  })
})
