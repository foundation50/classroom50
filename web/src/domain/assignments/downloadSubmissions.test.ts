import { describe, it, expect, vi, beforeEach } from "vitest"
import JSZip from "jszip"

import { downloadAllSubmissions, ZipAssemblyError } from "./downloadSubmissions"
import { fetchRepoArchive } from "@/github-core/repoArchiveReads"
import type { GitHubClient } from "@/github-core/client"

vi.mock("@/github-core/repoArchiveReads", () => ({
  fetchRepoArchive: vi.fn(),
}))

const mockedFetch = vi.mocked(fetchRepoArchive)
const client = {} as GitHubClient

const archive = (repo: string) => ({
  bytes: new Uint8Array([80, 75]).buffer,
  filename: `${repo}.zip`,
})

const run = (owners: string[], onProgress?: (p: unknown) => void) =>
  downloadAllSubmissions({
    client,
    org: "org",
    classroom: "cs101",
    assignment: "hw1",
    owners,
    onProgress: onProgress as never,
  })

beforeEach(() => {
  mockedFetch.mockReset()
})

describe("downloadAllSubmissions", () => {
  it("packages one entry per fetched owner and counts them", async () => {
    mockedFetch.mockImplementation((_c, _org, repo) =>
      Promise.resolve(archive(repo)),
    )

    const { blob, summary } = await run(["alice", "bob"])
    expect(summary.total).toBe(2)
    expect(summary.fetched).toBe(2)
    expect(summary.empty).toHaveLength(0)
    expect(summary.failed).toHaveLength(0)
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(0)
  })

  it("records an empty (missing) repo and excludes it, without aborting", async () => {
    mockedFetch.mockImplementation((_c, _org, repo) =>
      repo.includes("bob")
        ? Promise.resolve(null)
        : Promise.resolve(archive(repo)),
    )

    const { summary } = await run(["alice", "bob"])
    expect(summary.fetched).toBe(1)
    expect(summary.empty.map((r) => r.owner)).toEqual(["bob"])
    expect(summary.results).toHaveLength(2)
  })

  it("records a failed repo and still packages the rest", async () => {
    mockedFetch.mockImplementation((_c, _org, repo) =>
      repo.includes("bob")
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(archive(repo)),
    )

    const { summary } = await run(["alice", "bob"])
    expect(summary.fetched).toBe(1)
    expect(summary.failed.map((r) => r.owner)).toEqual(["bob"])
    expect(summary.failed[0].reason).toBe("boom")
  })

  it("fires onProgress once per owner with increasing done", async () => {
    mockedFetch.mockImplementation((_c, _org, repo) =>
      Promise.resolve(archive(repo)),
    )
    const seen: { done: number; total: number }[] = []

    await run(["alice", "bob", "carol"], (p) =>
      seen.push(p as { done: number; total: number }),
    )
    expect(seen).toHaveLength(3)
    expect(seen.map((p) => p.done)).toEqual([1, 2, 3])
    expect(seen.every((p) => p.total === 3)).toBe(true)
  })

  it("returns an empty summary and makes no calls for no owners", async () => {
    const { summary } = await run([])
    expect(summary).toEqual({
      total: 0,
      fetched: 0,
      empty: [],
      failed: [],
      results: [],
    })
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it("derives the repo name from classroom-assignment-owner", async () => {
    mockedFetch.mockImplementation((_c, _org, repo) =>
      Promise.resolve(archive(repo)),
    )

    await run(["Alice"])
    expect(mockedFetch).toHaveBeenCalledWith(
      client,
      "org",
      "cs101-hw1-alice",
      expect.objectContaining({ signal: undefined }),
    )
  })

  it("dedupes owners case-insensitively so entries aren't duplicated", async () => {
    mockedFetch.mockImplementation((_c, _org, repo) =>
      Promise.resolve(archive(repo)),
    )

    const { summary } = await run(["alice", "Alice", "bob"])
    expect(summary.total).toBe(2)
    expect(summary.fetched).toBe(2)
    expect(mockedFetch).toHaveBeenCalledTimes(2)
  })

  it("throws ZipAssemblyError when the combined zip can't be built", async () => {
    mockedFetch.mockImplementation((_c, _org, repo) =>
      Promise.resolve(archive(repo)),
    )
    const spy = vi
      .spyOn(JSZip.prototype, "generateAsync")
      .mockRejectedValueOnce(new Error("oom"))

    await expect(run(["alice"])).rejects.toBeInstanceOf(ZipAssemblyError)
    spy.mockRestore()
  })
})
