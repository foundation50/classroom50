import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitHubClient } from "@/github-core/client"

vi.mock("@/github-core/configRepoReads", () => ({
  getConfigRepoBranch: vi.fn(async () => "main"),
  getBranchRef: vi.fn(async () => ({ object: { sha: "REF" } })),
  getCommit: vi.fn(async () => ({ tree: { sha: "BASETREE" } })),
}))
vi.mock("../classrooms", () => ({
  assertClassroomNotArchived: vi.fn(async () => undefined),
  withGitConflictRetry: <T>(run: () => Promise<T>) => run(),
}))

type TreeWrite = { tree: { path: string; content: string }[] }
// Typed by signature so the recorded call args stay indexable.
const createGitTree =
  vi.fn<(client: unknown, opts: TreeWrite) => Promise<{ sha: string }>>()
const createGitCommit =
  vi.fn<(client: unknown, opts: unknown) => Promise<{ sha: string }>>()
const updateRef = vi.fn<(...args: unknown[]) => Promise<unknown>>()
vi.mock("@/github-core/mutations", () => ({
  createGitTree: (...args: unknown[]) =>
    createGitTree(...(args as Parameters<typeof createGitTree>)),
  createGitCommit: (...args: unknown[]) =>
    createGitCommit(...(args as Parameters<typeof createGitCommit>)),
  updateRef: (...args: unknown[]) => updateRef(...args),
}))

const reconcileLockTemplateAccess =
  vi.fn<
    (
      client: unknown,
      org: string,
      classroom: string,
      slug: string,
      template: unknown,
      locked: boolean,
      assignments?: unknown,
    ) => Promise<string | undefined>
  >()
const resolveTemplateGrant =
  vi.fn<(...args: unknown[]) => Promise<string | undefined>>()
vi.mock("./createEdit", () => ({
  reconcileLockTemplateAccess: (...args: unknown[]) =>
    reconcileLockTemplateAccess(
      ...(args as Parameters<typeof reconcileLockTemplateAccess>),
    ),
  resolveTemplateGrant: (...args: unknown[]) => resolveTemplateGrant(...args),
}))

// The target's view of each template repo; null is a 404.
const repos = new Map<string, { private: boolean } | null>()
const getRepo = vi.fn(
  async (_client: unknown, owner: string, repo: string) =>
    repos.get(`${owner}/${repo}`) ?? null,
)
vi.mock("@/github-core/repoReads", () => ({
  getRepo: (...args: unknown[]) =>
    getRepo(...(args as Parameters<typeof getRepo>)),
}))

let file: {
  schema: string
  assignments: {
    slug: string
    locked?: boolean
    template?: { owner: string; repo: string; branch: string }
  }[]
}
vi.mock("../queries/assignments", () => ({
  getAssignmentsFile: vi.fn(async () => file),
}))

import {
  copyAssignments,
  deleteAssignments,
  setAssignmentsLock,
} from "./bulkActions"
import type { Assignment } from "@/types/classroom"

const client = {} as GitHubClient
const ORG = "acme"
const CLASSROOM = "cs50"

// The content of the single tree write, parsed back out.
const writtenAssignments = () => {
  // (client, options) — the tree write is the second argument.
  const call = createGitTree.mock.calls[0][1]
  return JSON.parse(call.tree[0].content) as typeof file
}

beforeEach(() => {
  createGitTree.mockReset().mockResolvedValue({ sha: "NEWTREE" })
  createGitCommit.mockReset().mockResolvedValue({ sha: "NEWCOMMIT" })
  updateRef.mockReset().mockResolvedValue({})
  reconcileLockTemplateAccess.mockReset().mockResolvedValue(undefined)
  file = {
    schema: "classroom50/assignments/v1",
    assignments: [
      { slug: "hw1" },
      { slug: "hw2", locked: true },
      { slug: "hw3" },
    ],
  }
})

describe("setAssignmentsLock", () => {
  // N assignments, one commit.
  it("writes one tree and one commit for the whole selection", async () => {
    await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw1", "hw3"],
      locked: true,
    })

    expect(createGitTree).toHaveBeenCalledTimes(1)
    expect(createGitCommit).toHaveBeenCalledTimes(1)
    expect(updateRef).toHaveBeenCalledTimes(1)

    const next = writtenAssignments()
    expect(next.assignments.find((a) => a.slug === "hw1")?.locked).toBe(true)
    expect(next.assignments.find((a) => a.slug === "hw3")?.locked).toBe(true)
    // Untouched by the selection, and still locked from before.
    expect(next.assignments.find((a) => a.slug === "hw2")?.locked).toBe(true)
  })

  it("reports only the slugs whose flag actually moved", async () => {
    const result = await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw1", "hw2"],
      locked: true,
    })

    expect(result.changed).toEqual(["hw1"])
    expect(result.newCommitSha).toBe("NEWCOMMIT")
  })

  it("commits nothing when every selected assignment is already in state", async () => {
    const result = await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw2"],
      locked: true,
    })

    expect(createGitTree).not.toHaveBeenCalled()
    expect(result.changed).toEqual([])
    expect(result.newCommitSha).toBeNull()
  })

  // Matches the CLI's omitempty: unlock drops the key.
  it("drops the key on unlock instead of writing false", async () => {
    await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw2"],
      locked: false,
    })

    const entry = writtenAssignments().assignments.find(
      (a) => a.slug === "hw2",
    )!
    expect("locked" in entry).toBe(false)
  })

  it("reports a slug that vanished between render and submit", async () => {
    const result = await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw1", "gone"],
      locked: true,
    })

    expect(result.missing).toEqual(["gone"])
    expect(result.changed).toEqual(["hw1"])
  })

  // Reconcile runs for every present assignment, not only the changed ones: a
  // prior run may have committed the flip and then failed the grant/revoke.
  it("reconciles template access per selected assignment, including no-ops", async () => {
    await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw1", "hw2"],
      locked: true,
    })

    expect(reconcileLockTemplateAccess).toHaveBeenCalledTimes(2)
  })

  // The grant is a team permission on the template repo, so one write covers
  // every assignment on that template; each of them still gets the warning.
  it("reconciles a template shared by several assignments once", async () => {
    const template = { owner: ORG, repo: "tpl", branch: "main" }
    file.assignments = [
      { slug: "hw1", template },
      { slug: "hw2", template },
      { slug: "hw3" },
    ]
    reconcileLockTemplateAccess.mockResolvedValue("could not revoke")

    const result = await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw1", "hw2", "hw3"],
      locked: true,
    })

    expect(reconcileLockTemplateAccess).toHaveBeenCalledTimes(2)
    expect(result.outcomes.map((o) => o.templateAccessWarning)).toEqual([
      "could not revoke",
      "could not revoke",
      "could not revoke",
    ])
  })

  // The reconcile decides whether a shared template is still in use from the
  // list it is handed, so it must see the selection's NEW state: hw3 is being
  // locked in this same run and must not count as an open sibling.
  it("hands the reconcile the assignments as written, with the new lock state", async () => {
    const template = { owner: ORG, repo: "tpl", branch: "main" }
    file.assignments = [
      { slug: "hw1", template },
      { slug: "hw2" },
      { slug: "hw3", template },
    ]

    await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw1", "hw3"],
      locked: true,
    })

    const [, , , , , lockedArg, assignments] =
      reconcileLockTemplateAccess.mock.calls[0]
    expect(lockedArg).toBe(true)
    expect(
      (assignments as { slug: string; locked?: boolean }[]).map((a) => [
        a.slug,
        a.locked ?? false,
      ]),
    ).toEqual([
      ["hw1", true],
      ["hw2", false],
      ["hw3", true],
    ])
  })

  it("passes the current list when nothing changed", async () => {
    await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw2"],
      locked: true,
    })
    const [, , , , , lockedArg, assignments] =
      reconcileLockTemplateAccess.mock.calls[0]
    expect(lockedArg).toBe(true)
    expect(assignments).toBe(file.assignments)
  })

  it("surfaces a template warning against its own slug", async () => {
    reconcileLockTemplateAccess.mockImplementation(async (...args) =>
      args[3] === "hw3" ? "could not revoke" : undefined,
    )

    const result = await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw1", "hw3"],
      locked: true,
    })

    expect(result.outcomes).toEqual([
      { slug: "hw1", templateAccessWarning: undefined },
      { slug: "hw3", templateAccessWarning: "could not revoke" },
    ])
  })
})

describe("deleteAssignments", () => {
  it("removes the whole selection in one commit", async () => {
    const result = await deleteAssignments(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw1", "hw3"],
    })

    expect(createGitTree).toHaveBeenCalledTimes(1)
    expect(createGitCommit).toHaveBeenCalledTimes(1)
    expect(writtenAssignments().assignments.map((a) => a.slug)).toEqual(["hw2"])
    expect(result.deleted).toEqual(["hw1", "hw3"])
  })

  it("skips slugs that are already gone and says so", async () => {
    const result = await deleteAssignments(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw1", "gone"],
    })

    expect(result.deleted).toEqual(["hw1"])
    expect(result.missing).toEqual(["gone"])
  })

  it("commits nothing when the whole selection is already gone", async () => {
    const result = await deleteAssignments(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["gone", "also-gone"],
    })

    expect(createGitTree).not.toHaveBeenCalled()
    expect(updateRef).not.toHaveBeenCalled()
    expect(result.newCommitSha).toBeNull()
  })
})

describe("copyAssignments", () => {
  const item = (
    slug: string,
    targetSlug: string,
    extra: Partial<Assignment> = {},
  ) => ({
    source: { slug, name: slug, ...extra } as Assignment,
    targetSlug,
  })
  const copy = (items: ReturnType<typeof item>[], canGrant = false) =>
    copyAssignments(client, {
      org: ORG,
      targetClassroom: CLASSROOM,
      items,
      canGrantTemplateAccess: canGrant,
    })

  beforeEach(() => {
    resolveTemplateGrant.mockReset().mockResolvedValue(undefined)
    getRepo.mockClear()
    repos.clear()
  })

  // N copies, one commit: the whole point of batching.
  it("appends every copy to the target in one commit", async () => {
    const result = await copy([item("a1", "a1"), item("a2", "a2")])

    expect(createGitTree).toHaveBeenCalledTimes(1)
    expect(createGitCommit).toHaveBeenCalledTimes(1)
    expect(updateRef).toHaveBeenCalledTimes(1)
    expect(writtenAssignments().assignments.map((a) => a.slug)).toEqual([
      "hw1",
      "hw2",
      "hw3",
      "a1",
      "a2",
    ])
    expect(result.newCommitSha).toBe("NEWCOMMIT")
    expect(result.outcomes).toEqual([
      { slug: "a1", targetSlug: "a1" },
      { slug: "a2", targetSlug: "a2" },
    ])
  })

  it("writes each copy under the slug it was handed", async () => {
    await copy([item("hw1", "hw1-2")])
    const written = writtenAssignments().assignments
    expect(written.map((a) => a.slug)).toContain("hw1-2")
  })

  // The planner is optimistic; the file as read for the write is the truth.
  it("leaves a copy whose slug is taken out of the commit and keeps the rest", async () => {
    const result = await copy([item("hw1", "hw1"), item("a2", "a2")])

    expect(createGitCommit).toHaveBeenCalledTimes(1)
    expect(writtenAssignments().assignments.map((a) => a.slug)).toEqual([
      "hw1",
      "hw2",
      "hw3",
      "a2",
    ])
    expect(result.outcomes[0].slug).toBe("hw1")
    expect(result.outcomes[0].error).toMatch(/already exists/)
    expect(result.outcomes[1]).toEqual({ slug: "a2", targetSlug: "a2" })
  })

  it("keeps two copies in one run from claiming one slug", async () => {
    const result = await copy([item("a1", "same"), item("a2", "same")])

    expect(result.outcomes[0]).toEqual({ slug: "a1", targetSlug: "same" })
    expect(result.outcomes[1].error).toMatch(/already exists/)
  })

  it("commits nothing when no copy is valid", async () => {
    const result = await copy([item("hw1", "hw1")])

    expect(createGitTree).not.toHaveBeenCalled()
    expect(result.newCommitSha).toBeNull()
  })

  it("refuses a copy whose template is gone, before any write", async () => {
    const template = { owner: ORG, repo: "gone", branch: "main" }
    const result = await copy([item("a1", "a1", { template })])

    expect(createGitTree).not.toHaveBeenCalled()
    expect(result.outcomes[0].error).toMatch(/not visible/)
  })

  it("grants the team read on a private template after the commit", async () => {
    const template = { owner: ORG, repo: "tpl", branch: "main" }
    repos.set(`${ORG}/tpl`, { private: true })
    resolveTemplateGrant.mockResolvedValue("could not grant read")

    const result = await copy([item("a1", "a1", { template })], true)

    expect(resolveTemplateGrant).toHaveBeenCalledTimes(1)
    expect(result.outcomes[0]).toEqual({
      slug: "a1",
      targetSlug: "a1",
      templateAccessWarning: "could not grant read",
    })
  })

  // A locked source copies as locked; the grant waits for the unlock.
  it("withholds the grant for a locked copy", async () => {
    const template = { owner: ORG, repo: "tpl", branch: "main" }
    repos.set(`${ORG}/tpl`, { private: true })

    await copy([item("a1", "a1", { template, locked: true })], true)

    expect(resolveTemplateGrant).not.toHaveBeenCalled()
  })

  it("grants a template shared by several copies once, warning each", async () => {
    const template = { owner: ORG, repo: "tpl", branch: "main" }
    repos.set(`${ORG}/tpl`, { private: true })
    resolveTemplateGrant.mockResolvedValue("owner required")

    const result = await copy(
      [item("a1", "a1", { template }), item("a2", "a2", { template })],
      false,
    )

    expect(resolveTemplateGrant).toHaveBeenCalledTimes(1)
    expect(result.outcomes.map((o) => o.templateAccessWarning)).toEqual([
      "owner required",
      "owner required",
    ])
  })

  // A transient probe failure is that template's problem, not the batch's.
  it("fails only the copies whose template probe failed", async () => {
    const flaky = { owner: ORG, repo: "flaky", branch: "main" }
    getRepo.mockImplementation(async (_c, _owner, repo) => {
      if (repo === "flaky") throw new Error("502 from GitHub")
      return repos.get(`${ORG}/${repo}`) ?? null
    })

    const result = await copy([
      item("a1", "a1", { template: flaky }),
      item("a2", "a2"),
    ])

    expect(createGitCommit).toHaveBeenCalledTimes(1)
    expect(result.outcomes[0].error).toBe("502 from GitHub")
    expect(result.outcomes[1]).toEqual({ slug: "a2", targetSlug: "a2" })
    getRepo.mockImplementation(
      async (_c, owner, repo) => repos.get(`${owner}/${repo}`) ?? null,
    )
  })

  it("probes a template shared by several copies once", async () => {
    const template = { owner: ORG, repo: "tpl", branch: "main" }
    repos.set(`${ORG}/tpl`, { private: false })

    await copy([item("a1", "a1", { template }), item("a2", "a2", { template })])

    expect(getRepo).toHaveBeenCalledTimes(1)
  })
})
