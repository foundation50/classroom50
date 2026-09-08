import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"

import {
  createGitCommit,
  createGitTree,
  createRepoCommit,
  createRepoTree,
  updateRef,
  updateRepoRef,
} from "./gitObjects"

const makeClient = () => {
  const request = vi.fn<(path: string, init?: unknown) => Promise<unknown>>(
    async () => ({ sha: "NEW" }),
  )
  return { client: { request } as unknown as GitHubClient, request }
}

describe("git-data primitives", () => {
  it("createRepoTree posts the entries on the base tree of the given repo", async () => {
    const { client, request } = makeClient()
    const tree = [
      {
        path: "a.json",
        mode: "100644" as const,
        type: "blob" as const,
        content: "{}",
      },
      {
        path: "old",
        mode: "100644" as const,
        type: "blob" as const,
        sha: null,
      },
    ]
    await createRepoTree(client, {
      owner: "acme",
      repo: "hw1-ann",
      baseTreeSha: "BASE",
      tree,
    })
    expect(request).toHaveBeenCalledWith("/repos/acme/hw1-ann/git/trees", {
      method: "POST",
      body: { base_tree: "BASE", tree },
    })
  })

  it("createRepoCommit parents the commit on one sha", async () => {
    const { client, request } = makeClient()
    await createRepoCommit(client, {
      owner: "acme",
      repo: "hw1-ann",
      message: "m",
      treeSha: "T",
      parentSha: "P",
    })
    expect(request).toHaveBeenCalledWith("/repos/acme/hw1-ann/git/commits", {
      method: "POST",
      body: { message: "m", tree: "T", parents: ["P"] },
    })
  })

  // Fast-forward only, and a branch with a slash is one path segment to the
  // refs API, so it must be encoded rather than split.
  it("updateRepoRef moves the ref without force and encodes the branch", async () => {
    const { client, request } = makeClient()
    await updateRepoRef(client, {
      owner: "acme",
      repo: "hw1-ann",
      branch: "release/2026",
      commitSha: "C",
    })
    expect(request).toHaveBeenCalledWith(
      "/repos/acme/hw1-ann/git/refs/heads/release%2F2026",
      { method: "PATCH", body: { sha: "C", force: false } },
    )
  })

  it("the config-repo partials fix the repo and keep their old shapes", async () => {
    const { client, request } = makeClient()
    await createGitTree(client, { org: "acme", base_tree: "BASE", tree: [] })
    await createGitCommit(client, {
      org: "acme",
      message: "m",
      tree_sha: "T",
      parents: ["P"],
    })
    await updateRef(client, "acme", "C")
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      "/repos/acme/classroom50/git/trees",
      "/repos/acme/classroom50/git/commits",
      "/repos/acme/classroom50/git/refs/heads/main",
    ])
  })
})
