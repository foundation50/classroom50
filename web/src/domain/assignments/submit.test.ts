import { describe, expect, it, vi } from "vitest"

import { submitAssignment, normalizeRepoPath } from "./submit"
import type { GitHubClient } from "@/github-core/client"

describe("normalizeRepoPath", () => {
  it("strips leading ./ and /, normalizes backslashes", () => {
    expect(normalizeRepoPath("src/main.py")).toBe("src/main.py")
    expect(normalizeRepoPath("./src/main.py")).toBe("src/main.py")
    expect(normalizeRepoPath("/src/main.py")).toBe("src/main.py")
    expect(normalizeRepoPath("src\\main.py")).toBe("src/main.py")
  })

  it("rejects .. traversal", () => {
    expect(() => normalizeRepoPath("../escape.py")).toThrow(/Unsafe/)
    expect(() => normalizeRepoPath("a/../../b")).toThrow(/Unsafe/)
  })
})

// A fake GitHub client capturing the git-data writes submitAssignment makes.
function makeClient(opts: {
  defaultBranch: string
  existingTree: { path: string; type: string; sha: string; mode: string }[]
  truncated?: boolean
}) {
  const created = {
    blobs: [] as { content: string; encoding: string }[],
    tree: null as null | { hasBaseTree: boolean; paths: string[] },
    commit: null as null | { message: string; parents: string[] },
    updatedRef: null as null | { branch: string; sha: string },
  }
  let blobN = 0

  const request = vi.fn(
    async (path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? "GET"
      // getRepo
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path) && method === "GET") {
        return { default_branch: opts.defaultBranch }
      }
      // getBranchRefRepo
      if (path.includes("/git/ref/heads/") && method === "GET") {
        return { object: { sha: "parent-sha" } }
      }
      // getCommitByRepo
      if (path.includes("/git/commits/parent-sha") && method === "GET") {
        return { tree: { sha: "base-tree-sha" } }
      }
      // getRepoTreeRecursive
      if (path.includes("/git/trees/base-tree-sha") && method === "GET") {
        return { tree: opts.existingTree, truncated: opts.truncated ?? false }
      }
      // createBlobForRepo
      if (path.endsWith("/git/blobs") && method === "POST") {
        const body = init?.body as { content: string; encoding: string }
        created.blobs.push({ content: body.content, encoding: body.encoding })
        return { sha: `blob-${blobN++}` }
      }
      // createTreeFromFullEntries
      if (path.endsWith("/git/trees") && method === "POST") {
        const body = init?.body as {
          base_tree?: string
          tree: { path: string }[]
        }
        created.tree = {
          hasBaseTree: "base_tree" in body,
          paths: body.tree.map((e) => e.path),
        }
        return { sha: "new-tree-sha" }
      }
      // createCommitForAssignment
      if (path.endsWith("/git/commits") && method === "POST") {
        const body = init?.body as { message: string; parents: string[] }
        created.commit = { message: body.message, parents: body.parents }
        return { sha: "new-commit-sha" }
      }
      // updateRefForRepo
      if (path.includes("/git/refs/heads/") && method === "PATCH") {
        const body = init?.body as { sha: string }
        const branch = path.split("/git/refs/heads/")[1]
        created.updatedRef = { branch, sha: body.sha }
        return { ref: "", object: { sha: body.sha, type: "commit", url: "" } }
      }
      throw new Error(`unexpected request: ${method} ${path}`)
    },
  )

  return { client: { request } as unknown as GitHubClient, created }
}

const blob = (path: string, sha: string) => ({
  path,
  type: "blob",
  sha,
  mode: "100644",
})

const upload = (path: string, content = "x") => ({
  path,
  file: new File([content], path.split("/").pop() ?? path),
})

describe("submitAssignment", () => {
  it("commits a replace-all snapshot that preserves .github/** and .classroom50.yaml", async () => {
    const { client, created } = makeClient({
      defaultBranch: "main",
      existingTree: [
        blob(".classroom50.yaml", "yaml-sha"),
        blob(".github/workflows/autograde.yaml", "wf-sha"),
        blob("old-solution.py", "old-sha"), // a prior submission file -> dropped
      ],
    })

    const result = await submitAssignment({
      client,
      org: "acme",
      repo: "cs101-hw1-student1",
      assignment: "hw1",
      files: [upload("main.py"), upload("src/util.py")],
    })

    // Uploaded as base64 blobs.
    expect(created.blobs).toHaveLength(2)
    expect(created.blobs.every((b) => b.encoding === "base64")).toBe(true)

    // Authoritative tree (no base_tree) so unlisted files are dropped.
    expect(created.tree?.hasBaseTree).toBe(false)
    const paths = created.tree?.paths.sort()
    expect(paths).toEqual(
      [
        ".classroom50.yaml",
        ".github/workflows/autograde.yaml",
        "main.py",
        "src/util.py",
      ].sort(),
    )
    // The prior submission file is NOT carried over (replace-all).
    expect(created.tree?.paths).not.toContain("old-solution.py")

    // Commit message matches the CLI prefix, on the resolved default branch.
    expect(created.commit?.message).toBe("[Classroom 50] Submit hw1")
    expect(created.commit?.parents).toEqual(["parent-sha"])
    expect(created.updatedRef).toEqual({
      branch: "main",
      sha: "new-commit-sha",
    })
    expect(result).toEqual({
      commitSha: "new-commit-sha",
      branch: "main",
      fileCount: 2,
    })
  })

  it("commits to the repo's actual default branch (e.g. master), not a guessed main", async () => {
    const { client, created } = makeClient({
      defaultBranch: "master",
      existingTree: [blob(".github/workflows/autograde.yaml", "wf-sha")],
    })
    await submitAssignment({
      client,
      org: "acme",
      repo: "cs-hw-s",
      assignment: "hw",
      files: [upload("a.txt")],
    })
    expect(created.updatedRef?.branch).toBe("master")
  })

  it("drops an uploaded reserved path and preserves the real control blob (domain-enforced)", async () => {
    // The domain owns the "don't overwrite control paths" invariant, not the UI:
    // an uploaded .github/** path is dropped, and the existing workflow blob is
    // carried over by its own SHA — never uploaded, never duplicated.
    const { client, created } = makeClient({
      defaultBranch: "main",
      existingTree: [blob(".github/workflows/autograde.yaml", "wf-sha")],
    })
    await submitAssignment({
      client,
      org: "acme",
      repo: "r",
      assignment: "hw",
      files: [upload(".github/workflows/autograde.yaml"), upload("main.py")],
    })
    // No blob was created for the reserved path — only main.py was uploaded.
    expect(created.blobs).toHaveLength(1)
    const wf = created.tree?.paths.filter(
      (p) => p === ".github/workflows/autograde.yaml",
    )
    expect(wf).toHaveLength(1)
  })

  it("rejects a bare `.github` upload so it can't collide with the workflow dir", async () => {
    // `.github` (a file) would otherwise clash with the preserved `.github/`
    // tree in one authoritative tree — git can't have both, so the submit would
    // fail. The domain drops the reserved upload up front.
    const { client, created } = makeClient({
      defaultBranch: "main",
      existingTree: [blob(".github/workflows/autograde.yaml", "wf-sha")],
    })
    await submitAssignment({
      client,
      org: "acme",
      repo: "r",
      assignment: "hw",
      files: [upload(".github"), upload("main.py")],
    })
    expect(created.tree?.paths).not.toContain(".github")
    expect(created.tree?.paths).toContain(".github/workflows/autograde.yaml")
    expect(created.tree?.paths).toContain("main.py")
  })

  it("refuses to build a snapshot from a truncated tree read (would drop the workflow)", async () => {
    const { client } = makeClient({
      defaultBranch: "main",
      existingTree: [blob(".github/workflows/autograde.yaml", "wf-sha")],
      truncated: true,
    })
    await expect(
      submitAssignment({
        client,
        org: "acme",
        repo: "r",
        assignment: "hw",
        files: [upload("a.txt")],
      }),
    ).rejects.toThrow(/too large/i)
  })

  it("throws on an empty file set", async () => {
    const { client } = makeClient({ defaultBranch: "main", existingTree: [] })
    await expect(
      submitAssignment({
        client,
        org: "acme",
        repo: "r",
        assignment: "hw",
        files: [],
      }),
    ).rejects.toThrow(/No files/i)
  })
})
