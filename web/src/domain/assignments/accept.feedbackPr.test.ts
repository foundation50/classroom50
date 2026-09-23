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
// Captures the PR-create body and the feedback ref's base SHA. `markerless`
// models a no_autograder repo accepted without a marker: the marker history is
// empty and the branch log is seed + student work.
function makeClient(opts: { markerless?: boolean } = {}) {
  let prBody: Record<string, string> | undefined
  let feedbackBase: string | undefined
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
      if (
        method === "GET" &&
        url.startsWith(`/repos/${ORG}/${REPO}/commits?path=`)
      ) {
        return opts.markerless ? [] : [{ sha: "accept-sha" }]
      }
      if (method === "GET" && url.startsWith(`/repos/${ORG}/${REPO}/commits`)) {
        return opts.markerless
          ? [{ sha: "work" }, { sha: "seed-sha" }]
          : [{ sha: "accept-sha" }]
      }
      if (method === "GET" && url.startsWith(`/repos/${ORG}/${REPO}/pulls`)) {
        return []
      }
      if (method === "POST" && url === `/repos/${ORG}/${REPO}/git/refs`) {
        feedbackBase = init?.body?.sha as string
        return { ref: "refs/heads/feedback", object: { sha: feedbackBase } }
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
    feedbackBase: () => feedbackBase,
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

  // A no_autograder accept writes no marker, so the feedback branch freezes at
  // the repo's root commit (the template seed) instead.
  it("anchors a markerless no_autograder repo's Feedback PR on its root commit", async () => {
    mocked.assignment = { ...BASE_ENTRY, no_autograder: true }
    const { client, prBody, feedbackBase } = makeClient({ markerless: true })
    const result = await acceptAssignment({
      client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
    })
    expect(result.status).toBe("already-accepted")
    expect(feedbackBase()).toBe("seed-sha")
    expect(prBody()?.body).toBe(feedbackPrBody("main", RELEASE_URL, false))
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

// Fresh-create fixture for the no-setup-commit path: the template generate
// succeeds, the branch settles, and every request is recorded. `settle` shapes
// the branch wait: "root" (head with no parents), "pushed" (head with a
// parent), or "never" (the ref keeps 404ing).
function makeFreshClient(opts: {
  settle: "root" | "pushed" | "never"
  pagesStatus?: number
}) {
  const calls: string[] = []
  let feedbackBase: string | undefined
  const request = vi.fn(
    async (
      url: string,
      init?: { method?: string; body?: Record<string, unknown> },
    ) => {
      const method = init?.method ?? "GET"
      calls.push(`${method} ${url}`)
      if (method === "GET" && url === "/user") return { login: USER, id: 7 }
      if (url === `/user/memberships/orgs/${ORG}`) {
        return { state: "active", role: "admin" }
      }
      if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      if (method === "GET" && url === `/repos/${ORG}/hw1-starter`) {
        return { has_issues: true, has_wiki: false, has_projects: false }
      }
      if (method === "GET" && url === `/users/${ORG}`) return { id: 99 }
      if (method === "POST" && url === `/repos/${ORG}/hw1-starter/generate`) {
        return {
          name: REPO,
          full_name: `${ORG}/${REPO}`,
          default_branch: "main",
          html_url: `https://github.com/${ORG}/${REPO}`,
          ssh_url: `git@github.com:${ORG}/${REPO}.git`,
          private: true,
        }
      }
      if (method === "GET" && url === `/repos/${ORG}/${REPO}`) {
        return { name: REPO, default_branch: "main" }
      }
      if (
        method === "GET" &&
        url === `/repos/${ORG}/${REPO}/git/ref/heads/main`
      ) {
        if (opts.settle === "never") throw apiError(404, "Not Found")
        return { object: { sha: "head-sha" } }
      }
      if (
        method === "GET" &&
        url === `/repos/${ORG}/${REPO}/git/commits/head-sha`
      ) {
        return {
          sha: "head-sha",
          tree: { sha: "tree-sha" },
          parents: opts.settle === "pushed" ? [{ sha: "seed-sha" }] : [],
        }
      }
      if (method === "POST" && url === `/repos/${ORG}/${REPO}/pages`) {
        if (opts.pagesStatus && opts.pagesStatus >= 400) {
          throw apiError(opts.pagesStatus, "Pages refused")
        }
        return { html_url: "https://x" }
      }
      if (
        method === "GET" &&
        url.startsWith(`/repos/${ORG}/${REPO}/commits?path=`)
      ) {
        return []
      }
      if (method === "GET" && url.startsWith(`/repos/${ORG}/${REPO}/commits`)) {
        return opts.settle === "pushed"
          ? [{ sha: "head-sha" }, { sha: "seed-sha" }]
          : [{ sha: "head-sha" }]
      }
      if (method === "GET" && url.startsWith(`/repos/${ORG}/${REPO}/pulls`)) {
        return []
      }
      if (method === "POST" && url === `/repos/${ORG}/${REPO}/git/refs`) {
        feedbackBase = init?.body?.sha as string
        return { ref: "refs/heads/feedback", object: { sha: feedbackBase } }
      }
      if (method === "POST" && url === `/repos/${ORG}/${REPO}/pulls`) {
        return {
          number: 1,
          html_url: `https://github.com/${ORG}/${REPO}/pull/1`,
        }
      }
      if (method === "POST" && url.includes(`/repos/${ORG}/${REPO}/labels`)) {
        return {}
      }
      if (method === "POST" && url.includes(`/issues/1/labels`)) return []
      if (method === "PATCH" && url === `/repos/${ORG}/${REPO}`) return {}
      if (method === "PUT" && url.includes("/collaborators/")) return undefined
      throw new Error(`unexpected request: ${method} ${url}`)
    },
  )
  return {
    client: { request } as unknown as GitHubClient,
    calls,
    feedbackBase: () => feedbackBase,
  }
}

// The fresh no_autograder create: nothing is committed, but Pages and the
// Feedback PR still run once the generated branch settles, and the founder
// grant survives a branch that never does.
describe("acceptAssignment fresh no_autograder create", () => {
  const PAGES = { source: "branch", branch: "main", path: "/" } as const

  it("freezes feedback at the settled head when it is the root, without a history walk", async () => {
    mocked.assignment = { ...BASE_ENTRY, no_autograder: true }
    const { client, calls, feedbackBase } = makeFreshClient({ settle: "root" })
    const steps: { id: string; status: string }[] = []
    const result = await acceptAssignment({
      client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
      onStepUpdate: (u) => steps.push({ id: u.id, status: u.status }),
    })
    expect(result.status).toBe("created")
    expect(feedbackBase()).toBe("head-sha")
    expect(calls.some((c) => c.includes("/commits?"))).toBe(false)
    expect(
      calls.some((c) => c.startsWith("POST") && c.includes("/git/trees")),
    ).toBe(false)
    expect(calls.some((c) => c.includes("/collaborators/"))).toBe(true)
    expect(steps.filter((s) => s.id === "feedback").at(-1)?.status).toBe(
      "complete",
    )
  })

  it("walks to the root when the settled head already has a parent", async () => {
    mocked.assignment = { ...BASE_ENTRY, no_autograder: true }
    const { client, feedbackBase } = makeFreshClient({ settle: "pushed" })
    await acceptAssignment({
      client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
    })
    expect(feedbackBase()).toBe("seed-sha")
  })

  it("enables Pages after the branch settles and reports a refusal on the setup step", async () => {
    mocked.assignment = {
      ...BASE_ENTRY,
      no_autograder: true,
      feedback_pr: false,
      pages: PAGES,
    }
    const ok = makeFreshClient({ settle: "root" })
    await acceptAssignment({
      client: ok.client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
    })
    expect(
      ok.calls.filter((c) => c === `POST /repos/${ORG}/${REPO}/pages`),
    ).toHaveLength(1)

    const refused = makeFreshClient({ settle: "root", pagesStatus: 403 })
    const messages: string[] = []
    const result = await acceptAssignment({
      client: refused.client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
      onStepUpdate: (u) => {
        if (u.id === "setup" && u.message) messages.push(u.message.key)
      },
    })
    expect(result.status).toBe("created")
    expect(messages.at(-1)).toMatch(/^accept\.stepDone\.pagesSkipped\./)
  })

  // Parity with gh-student: a branch that never settles defers Pages and the
  // PR to a re-run, but the founder grant still lands (an un-granted repo is a
  // broken accept the student can't push to).
  it("still grants the founder when the branch never settles", async () => {
    vi.useFakeTimers()
    try {
      mocked.assignment = { ...BASE_ENTRY, no_autograder: true, pages: PAGES }
      const { client, calls } = makeFreshClient({ settle: "never" })
      const messages: Record<string, string> = {}
      const run = acceptAssignment({
        client,
        org: ORG,
        classroom: CLASSROOM,
        assignmentSlug: SLUG,
        onStepUpdate: (u) => {
          if (u.message) messages[u.id] = u.message.key
        },
      })
      await vi.runAllTimersAsync()
      const result = await run
      expect(result.status).toBe("created")
      expect(messages.setup).toBe("accept.stepDone.setupBranchUnsettled")
      expect(messages.feedback).toBe("accept.stepDone.feedbackDeferred")
      expect(calls.some((c) => c.includes("/pages"))).toBe(false)
      expect(calls.some((c) => c.includes("/pulls"))).toBe(false)
      expect(calls.some((c) => c.includes("/collaborators/"))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // Each step reports only what the assignment asked for: a feedback-only
  // accept says nothing about Pages, a pages-only one nothing about the PR.
  it("names only the configured steps when the branch never settles", async () => {
    vi.useFakeTimers()
    try {
      const runWith = async (entry: typeof BASE_ENTRY) => {
        mocked.assignment = entry
        const { client } = makeFreshClient({ settle: "never" })
        const messages: Record<string, string> = {}
        const run = acceptAssignment({
          client,
          org: ORG,
          classroom: CLASSROOM,
          assignmentSlug: SLUG,
          onStepUpdate: (u) => {
            if (u.message) messages[u.id] = u.message.key
          },
        })
        await vi.runAllTimersAsync()
        await run
        return messages
      }
      const feedbackOnly = await runWith({ ...BASE_ENTRY, no_autograder: true })
      expect(feedbackOnly.setup).toBe("accept.stepDone.setupSkipped")
      expect(feedbackOnly.feedback).toBe("accept.stepDone.feedbackDeferred")

      const pagesOnly = await runWith({
        ...BASE_ENTRY,
        no_autograder: true,
        feedback_pr: false,
        pages: PAGES,
      })
      expect(pagesOnly.setup).toBe("accept.stepDone.setupBranchUnsettled")
      expect(pagesOnly.feedback).toBe("accept.stepDone.feedbackSkipped")
    } finally {
      vi.useRealTimers()
    }
  })
})
