import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"

vi.mock("@/github-core/configRepoReads", () => ({
  getConfigRepoBranch: vi.fn(async () => "main"),
  getBranchRef: vi.fn(async () => ({ object: { sha: "REF" } })),
  getCommit: vi.fn(async () => ({ tree: { sha: "BASETREE" } })),
}))
vi.mock("../classrooms/archiveGuard", () => ({
  assertClassroomNotArchived: vi.fn(async () => undefined),
}))

type TreeWrite = { tree: { path: string; content: string }[] }
const createGitTree =
  vi.fn<(client: unknown, opts: TreeWrite) => Promise<{ sha: string }>>()
vi.mock("@/github-core/mutations", () => ({
  createGitTree: (...args: unknown[]) =>
    createGitTree(...(args as Parameters<typeof createGitTree>)),
  createGitCommit: vi.fn(async () => ({ sha: "NEWCOMMIT" })),
  updateRef: vi.fn(async () => ({})),
}))

let file: { schema: string; assignments: { slug: string }[] }
vi.mock("../queries/assignments", () => ({
  getAssignmentsFile: vi.fn(async () => file),
}))

import { deleteAssignment } from "./deleteAssignment"

const client = {} as GitHubClient

beforeEach(() => {
  createGitTree.mockReset().mockResolvedValue({ sha: "NEWTREE" })
  file = {
    schema: "classroom50/assignments/v1",
    assignments: [{ slug: "hw1" }, { slug: "hw2" }],
  }
})

describe("deleteAssignment", () => {
  it("returns the committed file and the commit it replaced", async () => {
    const result = await deleteAssignment(client, {
      org: "acme",
      classroom: "cs50",
      assignment: "hw1",
    })

    const written = JSON.parse(createGitTree.mock.calls[0][1].tree[0].content)
    expect(written.assignments.map((a: { slug: string }) => a.slug)).toEqual([
      "hw2",
    ])
    // What the hook seeds the read cache with: the file as committed.
    expect(result.assignments).toEqual(written)
    expect(result.previousCommitSha).toBe("REF")
    expect(result.newCommitSha).toBe("NEWCOMMIT")
  })

  it("refuses a slug that is not in the file", async () => {
    await expect(
      deleteAssignment(client, {
        org: "acme",
        classroom: "cs50",
        assignment: "nope",
      }),
    ).rejects.toThrow()
    expect(createGitTree).not.toHaveBeenCalled()
  })
})
