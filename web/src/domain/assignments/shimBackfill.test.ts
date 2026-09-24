import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { SHIM_BACKFILL_COMMIT_MESSAGE } from "@/util/commit"
import { parseClassroom50Yaml } from "@/util/yaml"
import {
  addAutogradeShim,
  resolveBackfillMarkerSource,
  type BackfillMarker,
} from "./shimBackfill"
import { defaultAutograderWorkflow } from "./autograderYaml"
import { AUTOGRADE_SHIM_PATH } from "./submissionTrigger"

type Call = { url: string; method: string; body?: unknown }
type TreeEntry = { path: string; content: string }

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

// A minimal fake GitHub: one student repo `o/r` on `main` whose shim and
// marker are present or absent, plus the git-data write endpoints and the
// user lookups the marker rebuild makes.
function fakeClient(opts: {
  repoExists?: boolean
  shimExists?: boolean
  // Body served at the shim path when shimExists; defaults to a default shim.
  shimContent?: string
  // Whether `.classroom50.yaml` exists at HEAD (defaults to present, the
  // built-in shape).
  markerExists?: boolean
  contentsStatus?: number
  workflowScope404?: boolean
  // Users the id lookups resolve; anyone else 404s (recorded as null).
  users?: Record<string, number>
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
      if (url === "/repos/o/r/contents/.classroom50.yaml?ref=head-sha") {
        if (opts.markerExists === false) throw apiError(404)
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from("classroom: c\nassignment: a\n").toString(
            "base64",
          ),
        }
      }
      const user = url.match(/^\/users\/([^/]+)$/)
      if (user) {
        const id = opts.users?.[user[1]]
        if (id === undefined) throw apiError(404)
        return { login: user[1], id }
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
const treeEntries = (calls: Call[]): TreeEntry[] =>
  (
    writes(calls).find((c) => c.url === "/repos/o/r/git/trees")?.body as {
      tree: TreeEntry[]
    }
  ).tree

const marker: BackfillMarker = {
  classroom: "cs101",
  assignment: "hw1",
  owner: "alice",
  secret: "abcd1234",
  template: { owner: "acme", repo: "hw1-template", branch: "main" },
}

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
      marker,
    })
    expect(outcome).toEqual({ status: "added" })

    const entries = treeEntries(calls)
    expect(entries.map((e) => e.path)).toEqual([AUTOGRADE_SHIM_PATH])
    // The repo's live default branch and the config repo's branch both flow
    // into the render.
    expect(entries[0].content).toBe(
      defaultAutograderWorkflow("o", "main", "master", "tag", ["phase1"]),
    )
    expect(entries[0].content).toContain("autograde-runner.yaml@master")

    const commit = writes(calls).find((c) => c.url === "/repos/o/r/git/commits")
    expect((commit?.body as { message: string }).message).toBe(
      SHIM_BACKFILL_COMMIT_MESSAGE,
    )
  })

  // A no_autograder accept writes no marker, and the runner the shim calls
  // refuses a repo without one, so the backfill lands both in one commit.
  it("adds the marker alongside the shim when the repo has none", async () => {
    const { client, calls } = fakeClient({
      shimExists: false,
      markerExists: false,
      users: { alice: 42, acme: 7 },
    })
    const outcome = await addAutogradeShim({
      client,
      org: "o",
      repo: "r",
      configBranch: "main",
      submissionMode: "every-push",
      marker,
    })
    expect(outcome).toEqual({ status: "added" })

    const entries = treeEntries(calls)
    expect(entries.map((e) => e.path).toSorted()).toEqual([
      ".classroom50.yaml",
      AUTOGRADE_SHIM_PATH,
    ])
    const yaml = entries.find((e) => e.path === ".classroom50.yaml")!.content
    expect(parseClassroom50Yaml(yaml)).toEqual({
      schema: "classroom50/repo-config/v1",
      classroom: "cs101",
      assignment: "hw1",
      secret: "abcd1234",
      owner: { username: "alice", id: 42 },
      source: {
        owner: "acme",
        owner_id: 7,
        repo: "hw1-template",
        branch: "main",
      },
    })
    // One commit: the runner's baseline walk must find the marker and the
    // shim introduced together.
    expect(
      writes(calls).filter((c) => c.url === "/repos/o/r/git/commits"),
    ).toHaveLength(1)
  })

  it("records unresolved ids as null and omits the source for a template-less entry", async () => {
    const { client, calls } = fakeClient({
      shimExists: false,
      markerExists: false,
    })
    await addAutogradeShim({
      client,
      org: "o",
      repo: "r",
      configBranch: "main",
      submissionMode: "every-push",
      marker: { classroom: "cs101", assignment: "hw1", owner: "alice" },
    })
    const yaml = treeEntries(calls).find(
      (e) => e.path === ".classroom50.yaml",
    )!.content
    const parsed = parseClassroom50Yaml(yaml)
    expect(parsed.owner).toEqual({ username: "alice", id: null })
    expect(parsed.secret).toBeUndefined()
    expect(parsed.source).toBeUndefined()
  })

  // A bulk run resolves the template owner once; each repo's marker then
  // costs one user read (the student), not two.
  it("uses a pre-resolved template owner id instead of looking it up per repo", async () => {
    const { client, calls } = fakeClient({
      shimExists: false,
      markerExists: false,
      users: { alice: 42, acme: 7 },
    })
    const source = await resolveBackfillMarkerSource(client, {
      secret: marker.secret,
      template: marker.template,
    })
    expect(source.template?.ownerId).toBe(7)
    const userReadsBefore = calls.filter((c) => c.url.startsWith("/users/"))
    expect(userReadsBefore.map((c) => c.url)).toEqual(["/users/acme"])

    await addAutogradeShim({
      client,
      org: "o",
      repo: "r",
      configBranch: "main",
      submissionMode: "every-push",
      marker: {
        classroom: "cs101",
        assignment: "hw1",
        owner: "alice",
        ...source,
      },
    })
    const userReads = calls
      .filter((c) => c.url.startsWith("/users/"))
      .map((c) => c.url)
    expect(userReads).toEqual(["/users/acme", "/users/alice"])
    const yaml = treeEntries(calls).find(
      (e) => e.path === ".classroom50.yaml",
    )!.content
    expect(parseClassroom50Yaml(yaml).source).toEqual({
      owner: "acme",
      owner_id: 7,
      repo: "hw1-template",
      branch: "main",
    })
    // An unresolved id is carried as null, still without a second lookup.
    const unresolved = await resolveBackfillMarkerSource(
      fakeClient({}).client,
      {
        template: { owner: "ghost", repo: "t" },
      },
    )
    expect(unresolved.template?.ownerId).toBeNull()
    expect(await resolveBackfillMarkerSource(client, unresolved)).toBe(
      unresolved,
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
      marker,
    })
    expect(outcome).toEqual({ status: "present" })
    expect(writes(calls)).toEqual([])
  })

  // A template that ships the default shim, or a backfill by a release that
  // wrote the shim alone, leaves a repo the runner refuses (no marker). Adding
  // the marker under the backfill subject keeps the root baseline; the only
  // other remedy, a heal re-accept, would move it.
  it("adds only the marker when the default shim is already present", async () => {
    const { client, calls } = fakeClient({
      shimExists: true,
      markerExists: false,
      users: { alice: 42, acme: 7 },
    })
    const outcome = await addAutogradeShim({
      client,
      org: "o",
      repo: "r",
      configBranch: "main",
      submissionMode: "every-push",
      marker,
    })
    expect(outcome).toEqual({ status: "markerAdded" })
    expect(treeEntries(calls).map((e) => e.path)).toEqual([".classroom50.yaml"])
    const commit = writes(calls).find((c) => c.url === "/repos/o/r/git/commits")
    expect((commit?.body as { message: string }).message).toBe(
      SHIM_BACKFILL_COMMIT_MESSAGE,
    )
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
      marker,
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
        marker,
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
      marker,
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
      marker,
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
