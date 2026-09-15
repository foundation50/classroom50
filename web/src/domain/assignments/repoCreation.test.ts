import { afterEach, describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { createAssignmentRepo } from "./repoCreation"

const ORG = "cs50"
const REPO = "cs50-hw1-alice"
const TEMPLATE = "hw1-template"

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

// Route-table client for the create/generate step. The create itself always
// answers 422 "already exists" (a concurrent accept won the race), and the
// follow-up GET /repos/{owner}/{name} 404s `repoLagAttempts` times first, the
// way GitHub's repo read lags a just-created repo for a few seconds.
function makeClient(opts: { repoLagAttempts: number }) {
  let repoReads = 0
  const request = vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET"
    if (method === "POST" && url === `/orgs/${ORG}/repos`) {
      throw apiError(422, "name already exists on this account")
    }
    if (method === "POST" && url === `/repos/${ORG}/${TEMPLATE}/generate`) {
      throw apiError(422, "name already exists on this account")
    }
    if (method === "GET" && url === `/repos/${ORG}/${REPO}`) {
      repoReads++
      if (repoReads <= opts.repoLagAttempts) {
        throw apiError(404, "Not Found")
      }
      return { name: REPO, default_branch: "main" }
    }
    throw new Error(`unexpected request: ${method} ${url}`)
  })
  return {
    client: { request } as unknown as GitHubClient,
    repoReads: () => repoReads,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

// Drives the retry backoff (0.5s, 1s, 2s, ...) without real waiting.
async function settle<T>(pending: Promise<T>): Promise<T> {
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(2_000)
  }
  return pending
}

describe("createAssignmentRepo after a 422 already-exists", () => {
  it("template-less: rides out a lagging 404 on the existing-repo read and reports already-accepted", async () => {
    vi.useFakeTimers()
    const { client, repoReads } = makeClient({ repoLagAttempts: 2 })

    const result = await settle(
      createAssignmentRepo({
        client,
        owner: ORG,
        name: REPO,
        fallbackBranch: "main",
      }),
    )

    expect(result.kind).toBe("already-accepted")
    expect(result.repo).toMatchObject({ name: REPO })
    // 404, 404, then 200.
    expect(repoReads()).toBe(3)
  })

  it("templated: the same lag tolerance applies after POST /generate", async () => {
    vi.useFakeTimers()
    const { client, repoReads } = makeClient({ repoLagAttempts: 1 })

    const result = await settle(
      createAssignmentRepo({
        client,
        templateOwner: ORG,
        templateRepo: TEMPLATE,
        owner: ORG,
        name: REPO,
        fallbackBranch: "main",
      }),
    )

    expect(result.kind).toBe("already-accepted")
    expect(repoReads()).toBe(2)
  })

  it("gives up once the lag budget is spent, surfacing the 404", async () => {
    vi.useFakeTimers()
    const { client } = makeClient({ repoLagAttempts: Infinity })

    const pending = createAssignmentRepo({
      client,
      owner: ORG,
      name: REPO,
      fallbackBranch: "main",
    })
    // Attach the rejection handler before advancing so the rejection is never
    // observed as unhandled between timer ticks.
    const outcome = pending.then(
      () => "resolved",
      (err: unknown) => err,
    )

    const err = await settle(outcome)
    expect(err).toBeInstanceOf(GitHubAPIError)
    expect((err as GitHubAPIError).status).toBe(404)
  })
})
