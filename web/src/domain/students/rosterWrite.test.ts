import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"

const readConfigRepoHead = vi.fn(async () => ({
  configBranch: "main",
  headSha: "HEAD",
  baseTreeSha: "BASETREE",
}))
const readConfigRepoHeadAt = vi.fn(async (_c, _o, configBranch: string) => ({
  configBranch,
  headSha: "HEAD",
  baseTreeSha: "BASETREE",
}))
const commitConfigRepoFiles = vi.fn(async () => ({
  newTreeSha: "NEWTREE",
  newCommitSha: "NEWCOMMIT",
  updatedRef: { ref: "refs/heads/main" },
}))
vi.mock("../configRepoWrite", () => ({
  readConfigRepoHead: (...a: unknown[]) => readConfigRepoHead(...(a as [])),
  readConfigRepoHeadAt: (...a: unknown[]) =>
    readConfigRepoHeadAt(...(a as [GitHubClient, string, string])),
  commitConfigRepoFiles: (...a: unknown[]) =>
    commitConfigRepoFiles(...(a as [])),
}))
const getRawFile = vi.fn(async () => "username,first_name\nann,Ann\n")
vi.mock("@/github-core/queries", () => ({
  getRawFile: (...a: unknown[]) => getRawFile(...(a as [])),
}))

import {
  commitRoster,
  readRosterForWrite,
  readRosterForWriteAt,
} from "./rosterWrite"

const client = {} as GitHubClient

beforeEach(() => {
  readConfigRepoHead.mockClear()
  readConfigRepoHeadAt.mockClear()
  commitConfigRepoFiles.mockClear()
  getRawFile.mockClear()
})

describe("readRosterForWrite", () => {
  it("reads roster.csv at the head it will commit against", async () => {
    const ctx = await readRosterForWrite(client, "org", "cs50")
    expect(readConfigRepoHead).toHaveBeenCalledWith(client, "org", "cs50")
    expect(getRawFile).toHaveBeenCalledWith(client, {
      org: "org",
      path: "cs50/roster.csv",
      ref: "HEAD",
    })
    expect(ctx).toEqual({
      configBranch: "main",
      headSha: "HEAD",
      baseTreeSha: "BASETREE",
      path: "cs50/roster.csv",
      currentCsv: "username,first_name\nann,Ann\n",
    })
  })

  it("the At variant uses the caller's branch and skips the guarded read", async () => {
    const ctx = await readRosterForWriteAt(client, "org", "cs50", "config")
    expect(readConfigRepoHead).not.toHaveBeenCalled()
    expect(readConfigRepoHeadAt).toHaveBeenCalledWith(client, "org", "config")
    expect(ctx.configBranch).toBe("config")
  })
})

describe("commitRoster", () => {
  it("commits the CSV as the single blob at the context's path", async () => {
    const ctx = await readRosterForWrite(client, "org", "cs50")
    const result = await commitRoster(client, "org", ctx, "next,csv\n", "Edit")
    expect(commitConfigRepoFiles).toHaveBeenCalledWith(
      client,
      "org",
      ctx,
      [
        {
          path: "cs50/roster.csv",
          mode: "100644",
          type: "blob",
          content: "next,csv\n",
        },
      ],
      "Edit",
    )
    expect(result.newCommitSha).toBe("NEWCOMMIT")
  })
})
