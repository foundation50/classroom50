import { describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "../client"
import { commitRepoFiles, commitRepoTree, readRepoHead } from "./repoCommit"

// A path-routing fake: the reads return a fixed tip, the writes record their
// bodies and hand back SHAs the next call can be checked against.
const makeClient = (opts?: { treeless?: boolean }) => {
  const writes: { path: string; body: unknown }[] = []
  const request = vi.fn(
    async (path: string, init?: { method?: string; body?: unknown }) => {
      if (init?.method === "POST" || init?.method === "PATCH") {
        writes.push({ path, body: init.body })
        if (path.endsWith("/git/trees")) return { sha: "NEWTREE" }
        if (path.endsWith("/git/commits")) return { sha: "NEWCOMMIT" }
        return {}
      }
      if (path.endsWith("/git/ref/heads/main"))
        return { object: { sha: "HEAD" } }
      if (path.endsWith("/git/commits/HEAD")) {
        return opts?.treeless
          ? { sha: "HEAD", parents: [] }
          : { sha: "HEAD", tree: { sha: "BASETREE" }, parents: [] }
      }
      throw new Error(`unexpected ${path}`)
    },
  )
  return { client: { request } as unknown as GitHubClient, writes }
}

const repo = { owner: "org", repo: "hw-alice" }

describe("readRepoHead", () => {
  it("returns the tip SHA, its tree, and the commit itself", async () => {
    const { client } = makeClient()
    await expect(readRepoHead(client, repo, "main")).resolves.toEqual({
      branch: "main",
      headSha: "HEAD",
      baseTreeSha: "BASETREE",
      commit: { sha: "HEAD", tree: { sha: "BASETREE" }, parents: [] },
    })
  })

  it("throws the caller's error when the tip has no tree yet", async () => {
    const { client } = makeClient({ treeless: true })
    await expect(
      readRepoHead(client, repo, "main", () => new Error("not ready")),
    ).rejects.toThrow("not ready")
  })
})

describe("commitRepoFiles", () => {
  it("builds the tree on the head, parents on it, and fast-forwards the branch", async () => {
    const { client, writes } = makeClient()
    const head = await readRepoHead(client, repo, "main")
    const entry = {
      path: "a.txt",
      mode: "100644" as const,
      type: "blob" as const,
      content: "hi",
    }
    const result = await commitRepoFiles(client, repo, head, [entry], "Msg")
    expect(result).toEqual({ treeSha: "NEWTREE", commitSha: "NEWCOMMIT" })
    expect(writes).toEqual([
      {
        path: "/repos/org/hw-alice/git/trees",
        body: { base_tree: "BASETREE", tree: [entry] },
      },
      {
        path: "/repos/org/hw-alice/git/commits",
        body: { message: "Msg", tree: "NEWTREE", parents: ["HEAD"] },
      },
      {
        path: "/repos/org/hw-alice/git/refs/heads/main",
        body: { sha: "NEWCOMMIT", force: false },
      },
    ])
  })
})

describe("commitRepoTree", () => {
  it("makes an empty commit when handed the head's own tree", async () => {
    const { client, writes } = makeClient()
    const head = await readRepoHead(client, repo, "main")
    await commitRepoTree(client, repo, head, head.baseTreeSha, "Empty")
    expect(writes.map((w) => w.path)).toEqual([
      "/repos/org/hw-alice/git/commits",
      "/repos/org/hw-alice/git/refs/heads/main",
    ])
    expect(writes[0].body).toEqual({
      message: "Empty",
      tree: "BASETREE",
      parents: ["HEAD"],
    })
  })
})
