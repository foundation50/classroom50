// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest"

const listClassroomDirs = vi.fn()
const listTeamMembers = vi.fn()
const getRawFile = vi.fn()
const getConfigRepoBranch = vi.fn()
const resolveClassroomTeamSlugs = vi.fn()

vi.mock("@/github-core/queries", () => ({
  listClassroomDirs: (...a: unknown[]) => listClassroomDirs(...a),
  listTeamMembers: (...a: unknown[]) => listTeamMembers(...a),
  getRawFile: (...a: unknown[]) => getRawFile(...a),
  REPO_READ_CONCURRENCY: 8,
}))
vi.mock("@/github-core/configRepoReads", () => ({
  getConfigRepoBranch: (...a: unknown[]) => getConfigRepoBranch(...a),
}))
vi.mock("./rosterPrimitives", () => ({
  resolveClassroomTeamSlugs: (...a: unknown[]) =>
    resolveClassroomTeamSlugs(...a),
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

import { buildIdentityDirectory } from "./identityDirectory"
import { rosterPath } from "@/util/rosterPath"
import { GitHubAPIError, type GitHubRateLimit } from "@/github-core/errors"

const client = {} as never
const ORG = "org"

const emptyRateLimit: GitHubRateLimit = {
  limit: null,
  remaining: null,
  used: null,
  reset: null,
  resource: null,
  retryAfter: null,
}

const notFoundError = () =>
  new GitHubAPIError({
    status: 404,
    url: "https://api.github.com/x",
    message: "not found",
    body: null,
    rateLimit: emptyRateLimit,
  })

const rateLimitError = () =>
  new GitHubAPIError({
    status: 429,
    url: "https://api.github.com/x",
    message: "rate limited",
    body: null,
    rateLimit: emptyRateLimit,
  })

const dirs = (...names: string[]) =>
  names.map((name) => ({ type: "dir", name, path: name }))

const slugsFor = (classroom: string) => ({
  student: `classroom50-${classroom}`,
  staff: {
    teacher: `classroom50-${classroom}-teacher`,
    hta: `classroom50-${classroom}-hta`,
    ta: `classroom50-${classroom}-ta`,
  },
})

// Members keyed by team slug; every other team lists empty (as a 404 would).
const membersBySlug = (map: Record<string, { id: number; login: string }[]>) =>
  listTeamMembers.mockImplementation(
    async (_c: unknown, _o: unknown, slug: string) => map[slug] ?? [],
  )

// roster.csv content keyed by classroom; a classroom without one 404s.
const rostersFor = (map: Record<string, string>) =>
  getRawFile.mockImplementation(
    async (_c: unknown, input: { path: string }) => {
      for (const [classroom, csv] of Object.entries(map)) {
        if (input.path === rosterPath(classroom)) return csv
      }
      throw notFoundError()
    },
  )

const rosterCsv = (
  rows: { username?: string; email?: string; github_id?: string }[],
) =>
  [
    "username,email,github_id",
    ...rows.map((r) =>
      [r.username ?? "", r.email ?? "", r.github_id ?? ""].join(","),
    ),
  ].join("\n")

beforeEach(() => {
  vi.clearAllMocks()
  getConfigRepoBranch.mockResolvedValue("main")
  listClassroomDirs.mockResolvedValue([])
  listTeamMembers.mockResolvedValue([])
  // Default: no classroom has a roster.csv.
  getRawFile.mockRejectedValue(notFoundError())
  resolveClassroomTeamSlugs.mockImplementation(
    async (_c: unknown, _o: unknown, classroom: string) => slugsFor(classroom),
  )
})

describe("buildIdentityDirectory", () => {
  it("unions two classrooms' teams (deduped by id) and maps roster emails with their source classroom", async () => {
    listClassroomDirs.mockResolvedValue(dirs("cs101", "cs102"))
    membersBySlug({
      "classroom50-cs101": [
        { id: 1, login: "alice" },
        { id: 2, login: "bob" },
      ],
      "classroom50-cs102": [
        { id: 2, login: "bob" },
        { id: 3, login: "carol" },
      ],
    })
    rostersFor({
      cs101: rosterCsv([
        { username: "alice", email: "a@x.com", github_id: "1" },
      ]),
      cs102: rosterCsv([
        { username: "carol", email: "c@x.com", github_id: "3" },
      ]),
    })

    const directory = await buildIdentityDirectory(client, ORG)
    expect(directory.degraded).toBe(false)
    expect(directory.members).toEqual([
      { id: 1, login: "alice", classrooms: ["cs101"] },
      { id: 2, login: "bob", classrooms: ["cs101", "cs102"] },
      { id: 3, login: "carol", classrooms: ["cs102"] },
    ])
    expect(directory.byEmail.get("a@x.com")).toEqual({
      id: 1,
      login: "alice",
      classroom: "cs101",
    })
    expect(directory.byEmail.get("c@x.com")).toEqual({
      id: 3,
      login: "carol",
      classroom: "cs102",
    })
    // One branch resolve for the whole build, not one per classroom.
    expect(getConfigRepoBranch).toHaveBeenCalledTimes(1)
  })

  it("marks an email ambiguous when two rosters claim it with different ids", async () => {
    listClassroomDirs.mockResolvedValue(dirs("cs101", "cs102"))
    rostersFor({
      cs101: rosterCsv([
        { username: "alice", email: "shared@x.com", github_id: "1" },
      ]),
      cs102: rosterCsv([
        { username: "mallory", email: "shared@x.com", github_id: "2" },
      ]),
    })

    const directory = await buildIdentityDirectory(client, ORG)
    expect(directory.byEmail.get("shared@x.com")).toBe("ambiguous")
    expect(directory.degraded).toBe(false)
  })

  it("keeps the first classroom for a repeated email+id, adopting a login the first row lacked", async () => {
    // Dirs arrive out of name order: the fold must still see cs101 first.
    listClassroomDirs.mockResolvedValue(dirs("cs102", "cs101"))
    rostersFor({
      cs101: rosterCsv([{ email: "a@x.com", github_id: "1" }]),
      cs102: rosterCsv([
        { username: "alice", email: "a@x.com", github_id: "1" },
      ]),
    })

    const directory = await buildIdentityDirectory(client, ORG)
    expect(directory.byEmail.get("a@x.com")).toEqual({
      id: 1,
      login: "alice",
      classroom: "cs101",
    })
  })

  it("skips roster rows whose github_id is unusable", async () => {
    listClassroomDirs.mockResolvedValue(dirs("cs101"))
    rostersFor({
      cs101: rosterCsv([
        { username: "a", email: "a@x.com", github_id: "" },
        { username: "b", email: "b@x.com", github_id: "0" },
        { username: "c", email: "c@x.com", github_id: "nope" },
      ]),
    })

    const directory = await buildIdentityDirectory(client, ORG)
    expect(directory.byEmail.size).toBe(0)
    expect(directory.degraded).toBe(false)
  })

  it("one classroom's failing team read sets degraded but keeps the other classroom's data", async () => {
    listClassroomDirs.mockResolvedValue(dirs("cs101", "cs102"))
    listTeamMembers.mockImplementation(
      async (_c: unknown, _o: unknown, slug: string) => {
        if (slug.startsWith("classroom50-cs101")) throw new Error("boom")
        return slug === "classroom50-cs102" ? [{ id: 3, login: "carol" }] : []
      },
    )
    rostersFor({
      cs102: rosterCsv([
        { username: "carol", email: "c@x.com", github_id: "3" },
      ]),
    })

    const directory = await buildIdentityDirectory(client, ORG)
    expect(directory.degraded).toBe(true)
    expect(directory.members).toEqual([
      { id: 3, login: "carol", classrooms: ["cs102"] },
    ])
    expect(directory.byEmail.get("c@x.com")).toEqual({
      id: 3,
      login: "carol",
      classroom: "cs102",
    })
  })

  it("treats a missing roster.csv (404) as 'no roster', not degradation", async () => {
    listClassroomDirs.mockResolvedValue(dirs("cs101"))
    membersBySlug({
      "classroom50-cs101": [{ id: 1, login: "alice" }],
    })
    // getRawFile keeps its default 404 rejection.

    const directory = await buildIdentityDirectory(client, ORG)
    expect(directory.degraded).toBe(false)
    expect(directory.byEmail.size).toBe(0)
    expect(directory.members).toEqual([
      { id: 1, login: "alice", classrooms: ["cs101"] },
    ])
  })

  it("returns an empty degraded directory (never throws) when the classroom listing fails", async () => {
    listClassroomDirs.mockRejectedValue(new Error("boom"))

    const directory = await buildIdentityDirectory(client, ORG)
    expect(directory.degraded).toBe(true)
    expect(directory.byEmail.size).toBe(0)
    expect(directory.members).toEqual([])
  })

  it("a rate-limited classroom read stops the remaining scans from issuing requests", async () => {
    // 12 classrooms against a pool of 8: every scan's first read rejects
    // rate-limited, so only the in-flight batch ever issues requests and the
    // rest fail immediately (-> degraded) without a call.
    listClassroomDirs.mockResolvedValue(
      dirs(...Array.from({ length: 12 }, (_, i) => `cs${100 + i}`)),
    )
    resolveClassroomTeamSlugs.mockRejectedValue(rateLimitError())

    const directory = await buildIdentityDirectory(client, ORG)
    expect(directory.degraded).toBe(true)
    expect(resolveClassroomTeamSlugs).toHaveBeenCalledTimes(8)
    expect(listTeamMembers).not.toHaveBeenCalled()
  })

  it("a NON-rate-limit classroom failure never stops the other scans", async () => {
    listClassroomDirs.mockResolvedValue(
      dirs(...Array.from({ length: 12 }, (_, i) => `cs${100 + i}`)),
    )
    resolveClassroomTeamSlugs.mockRejectedValue(new Error("boom"))

    const directory = await buildIdentityDirectory(client, ORG)
    expect(directory.degraded).toBe(true)
    expect(resolveClassroomTeamSlugs).toHaveBeenCalledTimes(12)
  })

  it("sorts members by login; a member on two classrooms' teams appears once with both", async () => {
    listClassroomDirs.mockResolvedValue(dirs("cs101", "cs102"))
    membersBySlug({
      "classroom50-cs101": [{ id: 5, login: "zed" }],
      "classroom50-cs102": [
        { id: 5, login: "zed" },
        { id: 6, login: "ann" },
      ],
    })

    const directory = await buildIdentityDirectory(client, ORG)
    expect(directory.members).toEqual([
      { id: 6, login: "ann", classrooms: ["cs102"] },
      { id: 5, login: "zed", classrooms: ["cs101", "cs102"] },
    ])
  })
})
