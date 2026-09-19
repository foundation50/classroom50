import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { SHIM_BACKFILL_COMMIT_MESSAGE } from "@/util/commit"
import { addAutogradeShim } from "./shimBackfill"
import { defaultAutograderWorkflow } from "./autograderYaml"
import { AUTOGRADE_SHIM_PATH } from "./submissionTrigger"

type Call = { url: string; method: string; body?: unknown }

function apiError(status: number, oauthScopes?: string): GitHubAPIError {
  return new GitHubAPIError({
    status,
    url: "https://api.github.com/test",
    message: "Not Found",
    body: { message: "Not Found" },
    rateLimit: {
      limit: null,
      remaining: null,
      reset: null,
      used: null,
      resource: null,
      retryAfter: null,
    },
    oauthScopes,
  })
}

// A minimal fake GitHub: one student repo `o/r` on `main` whose shim is
// present or absent, plus the git-data write endpoints.
function fakeClient(opts: {
  repoExists?: boolean
  shimExists?: boolean
  // Body served at the shim path when shimExists; defaults to a default shim.
  shimContent?: string
  contentsStatus?: number
  workflowScope404?: boolean
}) {
  const calls: Call[] = []
  const request = vi.fn(
    async (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? "GET"
      calls.push({ url, method, body: init?.body })

      if (url === "/repos/o/r") {
        if (opts.repoExists === false) throw apiError(404)
        return { default_branch: "main" }
      }
      if (url === "/repos/o/r/git/ref/heads/main") {
        return { object: { sha: "head-sha" } }
      }
      if (url === "/repos/o/r/git/commits/head-sha") {
        return { sha: "head-sha", tree: { sha: "tree-sha" } }
      }
      if (url === `/repos/o/r/contents/${AUTOGRADE_SHIM_PATH}?ref=head-sha`) {
        if (opts.contentsStatus) throw apiError(opts.contentsStatus)
        if (!opts.shimExists) throw apiError(404)
        const body =
          opts.shimContent ?? defaultAutograderWorkflow("o", "main", "main")
        return {
          content: Buffer.from(body, "utf-8").toString("base64"),
          encoding: "base64",
        }
      }
      if (url === "/repos/o/r/git/trees" && method === "POST") {
        if (opts.workflowScope404) throw apiError(404, "repo, read:org")
        return { sha: "new-tree" }
      }
      if (url === "/repos/o/r/git/commits" && method === "POST") {
        return { sha: "new-commit" }
      }
      if (url === "/repos/o/r/git/refs/heads/main" && method === "PATCH") {
        return {}
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    },
  )
  return { client: { request } as unknown as GitHubClient, calls }
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET")

describe("addAutogradeShim", () => {
  it("adds the default shim rendered for the assignment's mode and tags", async () => {
    const { client, calls } = fakeClient({ shimExists: false })
    const outcome = await addAutogradeShim({
      client,
      org: "o",
      repo: "r",
      configBranch: "master",
      submissionMode: "tag",
      submissionTags: ["phase1"],
    })
    expect(outcome).toEqual({ status: "added" })

    const tree = writes(calls).find((c) => c.url === "/repos/o/r/git/trees")
    const entry = (
      tree?.body as { tree: Array<{ path: string; content: string }> }
    ).tree[0]
    expect(entry.path).toBe(AUTOGRADE_SHIM_PATH)
    // The repo's live default branch and the config repo's branch both flow
    // into the render.
    expect(entry.content).toBe(
      defaultAutograderWorkflow("o", "main", "master", "tag", ["phase1"]),
    )
    expect(entry.content).toContain("autograde-runner.yaml@master")

    const commit = writes(calls).find((c) => c.url === "/repos/o/r/git/commits")
    expect((commit?.body as { message: string }).message).toBe(
      SHIM_BACKFILL_COMMIT_MESSAGE,
    )
  })

  it("leaves an existing shim untouched", async () => {
    const { client, calls } = fakeClient({ shimExists: true })
    const outcome = await addAutogradeShim({
      client,
      org: "o",
      repo: "r",
      configBranch: "main",
      submissionMode: "every-push",
    })
    expect(outcome).toEqual({ status: "present" })
    expect(writes(calls)).toEqual([])
  })

  it("reports a foreign file at the shim path as unrecognized, untouched", async () => {
    const { client, calls } = fakeClient({
      shimExists: true,
      shimContent: "name: Custom\non:\n  workflow_dispatch: {}\njobs: {}\n",
    })
    const outcome = await addAutogradeShim({
      client,
      org: "o",
      repo: "r",
      configBranch: "main",
      submissionMode: "every-push",
    })
    expect(outcome.status).toBe("unrecognized")
    expect(writes(calls)).toEqual([])
  })

  it("rethrows a non-404 contents error instead of guessing", async () => {
    const { client, calls } = fakeClient({ contentsStatus: 403 })
    await expect(
      addAutogradeShim({
        client,
        org: "o",
        repo: "r",
        configBranch: "main",
        submissionMode: "every-push",
      }),
    ).rejects.toBeInstanceOf(GitHubAPIError)
    expect(writes(calls)).toEqual([])
  })

  it("reports a missing repo as not accepted", async () => {
    const { client, calls } = fakeClient({ repoExists: false })
    const outcome = await addAutogradeShim({
      client,
      org: "o",
      repo: "r",
      configBranch: "main",
      submissionMode: "every-push",
    })
    expect(outcome).toEqual({ status: "notAccepted" })
    expect(writes(calls)).toEqual([])
  })

  it("classifies a workflow-scope 404 on the tree write", async () => {
    const { client } = fakeClient({ shimExists: false, workflowScope404: true })
    const outcome = await addAutogradeShim({
      client,
      org: "o",
      repo: "r",
      configBranch: "main",
      submissionMode: "every-push",
    })
    expect(outcome).toEqual({ status: "missingWorkflowScope" })
  })
})

describe("SHIM_BACKFILL_COMMIT_MESSAGE", () => {
  it("is byte-identical to the Go contract.ShimBackfillCommitMessage", () => {
    expect(SHIM_BACKFILL_COMMIT_MESSAGE).toBe(
      "[Classroom 50] Add autograde workflow (enable-autograder)\n\n[skip ci]",
    )
  })
})
