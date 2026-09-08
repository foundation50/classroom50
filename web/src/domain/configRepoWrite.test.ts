import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"

vi.mock("@/github-core/configRepoReads", () => ({
  getConfigRepoBranch: vi.fn(async () => "main"),
  getBranchRef: vi.fn(async () => ({ object: { sha: "REF" } })),
  getCommit: vi.fn(async () => ({ tree: { sha: "BASETREE" } })),
}))
const assertClassroomNotArchived = vi.fn(async () => undefined)
vi.mock("./classrooms", () => ({
  assertClassroomNotArchived: (...args: unknown[]) =>
    assertClassroomNotArchived(...(args as [])),
}))
const createGitTree = vi.fn(async () => ({ sha: "NEWTREE" }))
const createGitCommit = vi.fn(async () => ({ sha: "NEWCOMMIT" }))
const updateRef = vi.fn(async () => ({ ref: "refs/heads/main" }))
vi.mock("@/github-core/mutations", () => ({
  createGitTree: (...args: unknown[]) => createGitTree(...(args as [])),
  createGitCommit: (...args: unknown[]) => createGitCommit(...(args as [])),
  updateRef: (...args: unknown[]) => updateRef(...(args as [])),
}))

import {
  commitConfigRepoFiles,
  jsonFileEntry,
  readConfigRepoHead,
  readConfigRepoHeadAt,
} from "./configRepoWrite"

const client = {} as GitHubClient

beforeEach(() => {
  assertClassroomNotArchived.mockClear()
  createGitTree.mockClear()
  createGitCommit.mockClear()
  updateRef.mockClear()
})

describe("readConfigRepoHead", () => {
  it("runs the archive guard and returns the branch, head and base tree", async () => {
    const head = await readConfigRepoHead(client, "acme", "cs50")
    expect(assertClassroomNotArchived).toHaveBeenCalledWith(
      client,
      "acme",
      "cs50",
    )
    expect(head).toEqual({
      configBranch: "main",
      headSha: "REF",
      baseTreeSha: "BASETREE",
    })
  })

  it("the At variant skips the guard for callers that resolved the branch", async () => {
    const head = await readConfigRepoHeadAt(client, "acme", "release")
    expect(assertClassroomNotArchived).not.toHaveBeenCalled()
    expect(head.configBranch).toBe("release")
  })

  it("fails closed on an archived classroom before any read", async () => {
    assertClassroomNotArchived.mockRejectedValueOnce(new Error("archived"))
    await expect(readConfigRepoHead(client, "acme", "cs50")).rejects.toThrow(
      "archived",
    )
  })
})

describe("commitConfigRepoFiles", () => {
  it("builds the tree on the head, parents the commit on it, moves the ref, and prefixes the message", async () => {
    const head = { configBranch: "main", headSha: "REF", baseTreeSha: "BASE" }
    const tree = [jsonFileEntry("cs50/x.json", { a: 1 })]
    const result = await commitConfigRepoFiles(
      client,
      "acme",
      head,
      tree,
      "Do a thing",
    )
    expect(createGitTree).toHaveBeenCalledWith(client, {
      org: "acme",
      base_tree: "BASE",
      tree,
    })
    expect(createGitCommit).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        org: "acme",
        tree_sha: "NEWTREE",
        parents: ["REF"],
        message: expect.stringMatching(/Do a thing$/),
      }),
    )
    const message = (
      createGitCommit.mock.calls[0] as unknown as [unknown, { message: string }]
    )[1].message
    expect(message).not.toBe("Do a thing")
    expect(updateRef).toHaveBeenCalledWith(client, "acme", "NEWCOMMIT", "main")
    expect(result).toEqual({
      newTreeSha: "NEWTREE",
      newCommitSha: "NEWCOMMIT",
      updatedRef: { ref: "refs/heads/main" },
    })
  })
})

describe("jsonFileEntry", () => {
  // Byte-identical to what the CLI and a hand edit produce: 2-space indent and
  // a trailing newline.
  it("serializes with the shared JSON shape", () => {
    expect(jsonFileEntry("p.json", { b: [1, 2] })).toEqual({
      path: "p.json",
      mode: "100644",
      type: "blob",
      content: '{\n  "b": [\n    1,\n    2\n  ]\n}\n',
    })
  })
})
