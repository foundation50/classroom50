import { afterEach, describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import type { Assignment } from "@/types/classroom"
import { acceptAssignment } from "./accept"
import { studentRepoName } from "@/util/studentRepo"

const ORG = "cs50"
const CLASSROOM = "cs50"
const SLUG = "hw1"
const USER = "alice"
const REPO = studentRepoName(CLASSROOM, SLUG, USER)

// The accept flow reads the published manifest through
// fetchAssignmentFromPages; stub it so no network fetch runs.
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

// An init_shim assignment: template-less, auto_init seeds a README that the
// accept commit removes.
const INIT_SHIM_ENTRY: Assignment = {
  slug: SLUG,
  name: "Homework 1",
  mode: "individual",
  autograder: "default",
  feedback_pr: false,
  init_shim: true,
}

type TreeBody = {
  base_tree?: string
  tree: { path: string; sha?: string | null; content?: string }[]
}

// Route-table client for the individual accept path against a repo that
// already exists (the heal path) or is freshly created. `headParents` shapes
// the branch tip: [] models GitHub's auto_init seed (a root commit), a
// non-empty list models a repo the student has already pushed to.
// `refLagAttempts` makes the branch-ref read 404 that many times first,
// modelling post-create git-data lag.
function makeClient(opts: {
  repoExists: boolean
  markerPresent: boolean
  headParents: { sha: string }[]
  refLagAttempts?: number
}) {
  const treeBodies: TreeBody[] = []
  const requests: string[] = []
  let refReads = 0
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
        url === `/repos/${ORG}/${REPO}/git/ref/heads/main`
      ) {
        refReads++
        if (refReads <= (opts.refLagAttempts ?? 0)) {
          throw apiError(404, "Not Found")
        }
        return { object: { sha: "head-sha" } }
      }
      if (
        method === "GET" &&
        url === `/repos/${ORG}/${REPO}/git/commits/head-sha`
      ) {
        return {
          sha: "head-sha",
          tree: { sha: "head-tree" },
          parents: opts.headParents,
        }
      }
      if (
        method === "GET" &&
        url.startsWith(`/repos/${ORG}/${REPO}/git/trees/head-tree`)
      ) {
        return {
          truncated: false,
          tree: [
            { path: "README.md", type: "blob", sha: "readme-blob" },
            { path: "main.py", type: "blob", sha: "main-blob" },
          ],
        }
      }
      if (method === "POST" && url === `/repos/${ORG}/${REPO}/git/trees`) {
        treeBodies.push(init?.body as TreeBody)
        return { sha: "new-tree" }
      }
      if (method === "POST" && url === `/repos/${ORG}/${REPO}/git/commits`) {
        return { sha: "new-commit" }
      }
      if (
        method === "PATCH" &&
        url === `/repos/${ORG}/${REPO}/git/refs/heads/main`
      ) {
        return { object: { sha: "new-commit" } }
      }
      if (method === "PATCH" && url === `/repos/${ORG}/${REPO}`) return {}
      if (method === "PUT" && url.includes("/collaborators/")) return undefined
      throw new Error(`unexpected request: ${method} ${url}`)
    },
  )
  return {
    client: { request } as unknown as GitHubClient,
    requests,
    treeBodies,
  }
}

function repoObject() {
  return {
    name: REPO,
    full_name: `${ORG}/${REPO}`,
    default_branch: "main",
    html_url: `https://github.com/${ORG}/${REPO}`,
    ssh_url: `git@github.com:${ORG}/${REPO}.git`,
    private: true,
  }
}

const deletedPaths = (bodies: TreeBody[]) =>
  bodies.flatMap((b) => b.tree.filter((e) => e.sha === null).map((e) => e.path))

afterEach(() => {
  vi.useRealTimers()
})

// Issue #502 review: "Re-run setup" is now the primary action on an accepted
// but unprovisioned repo, and its copy promises to keep the student's work.
// On an init_shim repo the accept commit removes the auto_init README; that
// must only happen while the branch is still at that seed.
describe("acceptAssignment heal on an init_shim repo", () => {
  it("removes the seeded README when the repo is still at its root commit", async () => {
    mocked.assignment = INIT_SHIM_ENTRY
    const { client, treeBodies } = makeClient({
      repoExists: true,
      markerPresent: false,
      headParents: [],
    })
    const result = await acceptAssignment({
      client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
    })
    expect(result.status).toBe("already-accepted")
    expect(deletedPaths(treeBodies)).toEqual(["README.md"])
  })

  it("keeps README.md once the student has pushed on top of the seed", async () => {
    mocked.assignment = INIT_SHIM_ENTRY
    const { client, treeBodies, requests } = makeClient({
      repoExists: true,
      markerPresent: false,
      headParents: [{ sha: "seed-sha" }],
    })
    await acceptAssignment({
      client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
    })
    // The control files still land (the heal did its job)...
    expect(treeBodies).toHaveLength(1)
    expect(treeBodies[0].tree.map((e) => e.path)).toEqual(
      expect.arrayContaining([".classroom50.yaml"]),
    )
    // ...but nothing is deleted, and the tree wasn't even inspected for it.
    expect(deletedPaths(treeBodies)).toEqual([])
    expect(requests.some((r) => r.includes("/git/trees/head-tree"))).toBe(false)
  })
})

describe("acceptAssignment setup step under fresh-repo lag", () => {
  it("switches the setup row to 'still initializing' once, after the second retry", async () => {
    vi.useFakeTimers()
    mocked.assignment = INIT_SHIM_ENTRY
    const { client, requests } = makeClient({
      repoExists: false,
      markerPresent: false,
      headParents: [],
      refLagAttempts: 4,
    })
    const refReads = () =>
      requests.filter((r) => r.endsWith("/git/ref/heads/main")).length
    // Ref reads already attempted each time the waiting message fires.
    const waitingAfterReads: number[] = []

    const pending = acceptAssignment({
      client,
      org: ORG,
      classroom: CLASSROOM,
      assignmentSlug: SLUG,
      onStepUpdate: (u) => {
        if (
          u.id === "setup" &&
          u.status === "running" &&
          u.message?.key === "accept.steps.setupWaiting"
        ) {
          waitingAfterReads.push(refReads())
        }
      },
    })
    // Four lag retries: 0.5s + 1s + 2s + 4s of backoff.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
    }
    const result = await pending

    expect(result.status).toBe("created")
    // Exactly once, after the third failed read (attempt index 2), not on the
    // first or second.
    expect(waitingAfterReads).toEqual([3])
    // The commit still landed once the ref appeared.
    expect(
      requests.filter(
        (r) => r.startsWith("PATCH ") && r.endsWith("/git/refs/heads/main"),
      ),
    ).toHaveLength(1)
  })
})
