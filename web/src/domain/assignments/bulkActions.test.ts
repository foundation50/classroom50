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
// Typed by signature rather than by named parameters, so the recorded call
// args stay indexable without declaring bindings the linter counts as unused.
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
    ) => Promise<string | undefined>
  >()
vi.mock("./createEdit", () => ({
  reconcileLockTemplateAccess: (...args: unknown[]) =>
    reconcileLockTemplateAccess(
      ...(args as Parameters<typeof reconcileLockTemplateAccess>),
    ),
}))

const copyAssignment =
  vi.fn<
    (
      client: unknown,
      input: { targetSlug: string },
    ) => Promise<{ templateGrantWarning?: string }>
  >()
vi.mock("./copyReuse", () => ({
  copyAssignmentWithConflictRetry: (...args: unknown[]) =>
    copyAssignment(...(args as Parameters<typeof copyAssignment>)),
}))

let file: { schema: string; assignments: { slug: string; locked?: boolean }[] }
vi.mock("../queries/assignments", () => ({
  getAssignmentsFile: vi.fn(async () => file),
}))

import {
  bulkCopyAssignments,
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
  // The point of the batched form: N assignments, one commit — not N commits
  // racing each other on the same file's ref.
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

  // Unlock drops the key rather than writing `locked: false`, matching the
  // CLI's omitempty wire shape.
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

  // Reconcile runs for every SELECTED assignment that exists, not only the
  // ones whose flag moved: a prior run may have committed the flip and then
  // failed the grant/revoke.
  it("reconciles template access per selected assignment, including no-ops", async () => {
    await setAssignmentsLock(client, {
      org: ORG,
      classroom: CLASSROOM,
      slugs: ["hw1", "hw2"],
      locked: true,
    })

    expect(reconcileLockTemplateAccess).toHaveBeenCalledTimes(2)
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

describe("bulkCopyAssignments", () => {
  const item = (slug: string, targetSlug: string) => ({
    source: { slug } as Assignment,
    targetSlug,
  })

  beforeEach(() => {
    copyAssignment.mockReset().mockResolvedValue({})
  })

  it("copies each source under the slug it was handed", async () => {
    const outcomes = await bulkCopyAssignments(client, {
      org: ORG,
      targetClassroom: CLASSROOM,
      items: [item("hw1", "hw1-2"), item("hw2", "hw2")],
      canGrantTemplateAccess: false,
    })

    expect(copyAssignment.mock.calls.map((c) => c[1].targetSlug)).toEqual([
      "hw1-2",
      "hw2",
    ])
    expect(outcomes).toEqual([
      { slug: "hw1", targetSlug: "hw1-2" },
      { slug: "hw2", targetSlug: "hw2" },
    ])
  })

  // The whole reason the run reports per assignment instead of one verdict.
  it("keeps going after a failed copy and reports which one failed", async () => {
    copyAssignment.mockRejectedValueOnce(new Error("repo already exists"))

    const outcomes = await bulkCopyAssignments(client, {
      org: ORG,
      targetClassroom: CLASSROOM,
      items: [item("hw1", "hw1"), item("hw2", "hw2")],
      canGrantTemplateAccess: false,
    })

    expect(copyAssignment).toHaveBeenCalledTimes(2)
    expect(outcomes[0]).toEqual({
      slug: "hw1",
      error: "repo already exists",
    })
    expect(outcomes[1]).toEqual({ slug: "hw2", targetSlug: "hw2" })
  })

  // A copy can land and still leave students unable to accept it, when the
  // target classroom's team could not be granted read on a private template.
  it("carries a template-grant warning through to the outcome", async () => {
    copyAssignment.mockResolvedValueOnce({
      templateGrantWarning: "could not grant read",
    })

    const outcomes = await bulkCopyAssignments(client, {
      org: ORG,
      targetClassroom: CLASSROOM,
      items: [item("hw1", "hw1")],
      canGrantTemplateAccess: true,
    })

    expect(outcomes[0]).toEqual({
      slug: "hw1",
      targetSlug: "hw1",
      templateAccessWarning: "could not grant read",
    })
  })

  it("reports progress after every item", async () => {
    const seen: number[] = []
    await bulkCopyAssignments(client, {
      org: ORG,
      targetClassroom: CLASSROOM,
      items: [item("hw1", "hw1"), item("hw2", "hw2")],
      canGrantTemplateAccess: false,
      onProgress: (outcomes) => seen.push(outcomes.length),
    })

    expect(seen).toEqual([1, 2])
  })
})
