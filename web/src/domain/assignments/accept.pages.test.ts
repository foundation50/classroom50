import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import type { Assignment } from "@/types/classroom"
import { acceptAssignment } from "./accept"
import type { AcceptStepUpdate } from "./accessPrimitives"
import { studentRepoName } from "@/util/studentRepo"

const ORG = "cs50"
const CLASSROOM = "cs50"
const SLUG = "site"
const USER = "alice"
const REPO = studentRepoName(CLASSROOM, SLUG, USER)
const PAGES_PATH = `/repos/${ORG}/${REPO}/pages`

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
    body: { message },
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

// A template-less init_shim assignment (auto_init seeds the default branch),
// with a Pages block: the shortest fresh-create path that still commits.
const entryWithPages = (pages: Assignment["pages"]): Assignment => ({
  slug: SLUG,
  name: "Site",
  mode: "individual",
  autograder: "default",
  feedback_pr: false,
  init_shim: true,
  pages,
})

function makeClient(opts: {
  repoExists: boolean
  markerPresent: boolean
  pagesOutcome?: GitHubAPIError
}) {
  const requests: string[] = []
  const pagesBodies: unknown[] = []
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
      if (method === "GET" && /\/repos\/[^/]+\/classroom50$/.test(url)) {
        return { default_branch: "main" }
      }
      if (method === "POST" && url === `/orgs/${ORG}/repos`) {
        if (opts.repoExists) {
          throw apiError(422, "name already exists on this account")
        }
        return repoObject()
      }
      if (method === "GET" && url === `/repos/${ORG}/${REPO}`) {
        return repoObject()
      }
      if (method === "GET" && url.includes(`/repos/${ORG}/${REPO}/contents/`)) {
        if (opts.markerPresent) return { type: "file" }
        throw apiError(404, "Not Found")
      }
      if (
        method === "GET" &&
        url === `/repos/${ORG}/${REPO}/git/ref/heads/master`
      ) {
        return { object: { sha: "head-sha" } }
      }
      if (
        method === "GET" &&
        url === `/repos/${ORG}/${REPO}/git/commits/head-sha`
      ) {
        return { sha: "head-sha", tree: { sha: "head-tree" }, parents: [] }
      }
      if (
        method === "GET" &&
        url.startsWith(`/repos/${ORG}/${REPO}/git/trees/head-tree`)
      ) {
        return { truncated: false, tree: [] }
      }
      if (method === "POST" && url === PAGES_PATH) {
        pagesBodies.push(init?.body)
        if (opts.pagesOutcome) throw opts.pagesOutcome
        return { html_url: `https://${ORG}.github.io/${REPO}/` }
      }
      if (method === "POST" && url === `/repos/${ORG}/${REPO}/git/trees`) {
        return { sha: "new-tree" }
      }
      if (method === "POST" && url === `/repos/${ORG}/${REPO}/git/commits`) {
        return { sha: "new-commit" }
      }
      if (
        method === "PATCH" &&
        url === `/repos/${ORG}/${REPO}/git/refs/heads/master`
      ) {
        return { object: { sha: "new-commit" } }
      }
      if (method === "PATCH" && url === `/repos/${ORG}/${REPO}`) return {}
      if (method === "PUT" && url.includes("/collaborators/")) return undefined
      throw new Error(`unexpected request: ${method} ${url}`)
    },
  )
  return { client: { request } as unknown as GitHubClient, requests, pagesBodies }
}

// The repo's real default branch is `master`, deliberately different from the
// org default the flow pre-guesses, to prove the Pages body uses the SETTLED
// branch.
function repoObject() {
  return {
    name: REPO,
    full_name: `${ORG}/${REPO}`,
    default_branch: "master",
    html_url: `https://github.com/${ORG}/${REPO}`,
    ssh_url: `git@github.com:${ORG}/${REPO}.git`,
    private: true,
  }
}

const accept = (client: GitHubClient, updates: AcceptStepUpdate[] = []) =>
  acceptAssignment({
    client,
    org: ORG,
    classroom: CLASSROOM,
    assignmentSlug: SLUG,
    onStepUpdate: (u) => updates.push(u),
  })

describe("acceptAssignment with a pages block (issue #919)", () => {
  it("creates a branch-deployed site on the settled default branch BEFORE the accept commit", async () => {
    mocked.assignment = entryWithPages({ source: "branch" })
    const { client, requests, pagesBodies } = makeClient({
      repoExists: false,
      markerPresent: false,
    })
    const result = await accept(client)
    expect(result.status).toBe("created")
    expect(pagesBodies).toEqual([
      { build_type: "legacy", source: { branch: "master", path: "/" } },
    ])
    const pagesAt = requests.indexOf(`POST ${PAGES_PATH}`)
    const commitAt = requests.indexOf(`POST /repos/${ORG}/${REPO}/git/commits`)
    expect(pagesAt).toBeGreaterThan(-1)
    expect(pagesAt).toBeLessThan(commitAt)
  })

  it("sends build_type workflow with no source for a workflow-deployed site", async () => {
    mocked.assignment = entryWithPages({ source: "workflow" })
    const { client, pagesBodies } = makeClient({
      repoExists: false,
      markerPresent: false,
    })
    await accept(client)
    expect(pagesBodies).toEqual([{ build_type: "workflow" }])
  })

  it("honors a named branch and /docs", async () => {
    mocked.assignment = entryWithPages({
      source: "branch",
      branch: "gh-pages",
      path: "/docs",
    })
    const { client, pagesBodies } = makeClient({
      repoExists: false,
      markerPresent: false,
    })
    await accept(client)
    expect(pagesBodies).toEqual([
      { build_type: "legacy", source: { branch: "gh-pages", path: "/docs" } },
    ])
  })

  it("fails open on a refusal: accept succeeds and the setup step names the reason", async () => {
    mocked.assignment = entryWithPages({ source: "workflow" })
    const { client } = makeClient({
      repoExists: false,
      markerPresent: false,
      pagesOutcome: apiError(
        422,
        "Upgrade to GitHub Pro or make this repository public to enable Pages.",
      ),
    })
    const updates: AcceptStepUpdate[] = []
    const result = await accept(client, updates)
    expect(result.status).toBe("created")
    const setupDone = updates.filter(
      (u) => u.id === "setup" && u.status === "complete",
    )
    expect(setupDone.at(-1)?.message?.key).toBe(
      "accept.stepDone.pagesSkipped.plan",
    )
  })

  it("treats an already-configured site (409) as done without a note", async () => {
    mocked.assignment = entryWithPages({ source: "workflow" })
    const { client } = makeClient({
      repoExists: false,
      markerPresent: false,
      pagesOutcome: apiError(409, "GitHub Pages is already enabled."),
    })
    const updates: AcceptStepUpdate[] = []
    await accept(client, updates)
    const setupDone = updates.filter(
      (u) => u.id === "setup" && u.status === "complete",
    )
    expect(setupDone.at(-1)?.message?.key).toBe("accept.stepDone.setup")
  })

  it("does NOT touch Pages when healing an existing repo", async () => {
    mocked.assignment = entryWithPages({ source: "workflow" })
    const { client, requests } = makeClient({
      repoExists: true,
      markerPresent: false,
    })
    const result = await accept(client)
    expect(result.status).toBe("already-accepted")
    expect(requests.some((r) => r.endsWith("/pages"))).toBe(false)
  })

  it("does NOT touch Pages when the assignment has no pages block", async () => {
    mocked.assignment = entryWithPages(undefined)
    const { client, requests } = makeClient({
      repoExists: false,
      markerPresent: false,
    })
    await accept(client)
    expect(requests.some((r) => r.endsWith("/pages"))).toBe(false)
  })
})
