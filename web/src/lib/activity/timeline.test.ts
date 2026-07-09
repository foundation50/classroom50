import { describe, expect, it } from "vitest"

import type { GitHubCommit, GitHubWorkflowRun } from "@/hooks/github/types"
import type { ActivityEntry } from "@/lib/activity/activityStore"
import {
  classifyConfigCommit,
  commitToItem,
  matchesQuery,
  mergeTimeline,
  runToItem,
  sessionToItems,
  timelineToCsvRows,
  type TimelineItem,
} from "./timeline"

const commit = (
  message: string,
  over?: Partial<GitHubCommit>,
): GitHubCommit => ({
  sha: "abc1234def",
  html_url: "https://github.com/acme/classroom50/commit/abc1234def",
  commit: {
    message,
    author: { name: "Teacher", date: "2026-07-08T10:00:00Z" },
  },
  author: { login: "teacher", avatar_url: "" },
  ...over,
})

const run = (over?: Partial<GitHubWorkflowRun>): GitHubWorkflowRun => ({
  id: 100,
  path: ".github/workflows/collect-scores.yaml",
  status: "completed",
  conclusion: "success",
  created_at: "2026-07-08T11:00:00Z",
  run_started_at: "2026-07-08T11:00:05Z",
  updated_at: "2026-07-08T11:01:00Z",
  html_url: "https://github.com/acme/classroom50/actions/runs/100",
  event: "workflow_dispatch",
  ...over,
})

const label = (file: string | undefined, fallback: string | undefined) =>
  file ?? fallback ?? "workflow"

describe("classifyConfigCommit", () => {
  it("classifies by the verb/target after the prefix", () => {
    expect(
      classifyConfigCommit("[Classroom 50] Create assignment: cs/hw1"),
    ).toBe("assignment")
    expect(classifyConfigCommit("[Classroom 50] Update classroom cs")).toBe(
      "classroom",
    )
    expect(classifyConfigCommit("[Classroom 50] Add student: cs/alice")).toBe(
      "student",
    )
    expect(classifyConfigCommit("Update scores.json")).toBe("scores")
    expect(classifyConfigCommit("[Classroom 50] Bootstrap skeleton")).toBe(
      "config",
    )
  })
})

describe("commitToItem", () => {
  it("strips the prefix, classifies, and sets actor/href/time", () => {
    const item = commitToItem(
      commit("[Classroom 50] Create assignment: cs/hw1"),
    )
    expect(item.source).toBe("commit")
    expect(item.type).toBe("assignment")
    expect(item.label).toBe("Create assignment: cs/hw1")
    expect(item.actor).toBe("teacher")
    expect(item.href).toContain("/commit/abc1234def")
    expect(item.detail).toBe("abc1234") // short sha
    expect(item.at).toBe(Date.parse("2026-07-08T10:00:00Z"))
  })

  it("falls back to the commit author name for a workflow-authored commit", () => {
    const item = commitToItem(
      commit("Update scores.json", {
        author: null,
        commit: {
          message: "Update scores.json",
          author: { name: "github-actions[bot]", date: "2026-07-08T10:00:00Z" },
        },
      }),
    )
    expect(item.actor).toBe("github-actions[bot]")
    expect(item.type).toBe("scores")
  })
})

describe("runToItem", () => {
  it("maps a successful run to ok status with a workflow label", () => {
    const item = runToItem(run(), label)
    expect(item.source).toBe("run")
    expect(item.status).toBe("ok")
    expect(item.label).toBe("collect-scores.yaml")
    expect(item.href).toContain("/actions/runs/100")
  })

  it("maps an in-flight run to running", () => {
    expect(runToItem(run({ status: "in_progress" }), label).status).toBe(
      "running",
    )
  })

  it("maps a failed run to error", () => {
    expect(
      runToItem(run({ status: "completed", conclusion: "failure" }), label)
        .status,
    ).toBe("error")
  })

  it("uses the triggering actor when present", () => {
    const item = runToItem(
      run({ triggering_actor: { login: "teacher" } }),
      label,
    )
    expect(item.actor).toBe("teacher")
  })
})

describe("sessionToItems", () => {
  const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
    id: "e1",
    kind: "error",
    label: "boom",
    at: 1000,
    ...over,
  })

  it("maps errors and actions with the right status/type", () => {
    const items = sessionToItems([
      entry({ id: "e1", kind: "error", label: "boom", endpoint: "/x" }),
      entry({ id: "e2", kind: "action", label: "did a thing" }),
    ])
    expect(items[0]).toMatchObject({
      source: "session",
      type: "error",
      status: "error",
      detail: "/x",
    })
    expect(items[1]).toMatchObject({ type: "action", status: "info" })
  })

  it("prefers endpoint, then source, then HTTP status for detail (raw value + kind; prefix is localized in the row)", () => {
    const bySource = sessionToItems([entry({ source: "foo.tsx:1" })])[0]
    expect(bySource.detail).toBe("foo.tsx:1")
    expect(bySource.detailKind).toBe("source")

    const byStatus = sessionToItems([entry({ status: 404 })])[0]
    expect(byStatus.detail).toBe("404")
    expect(byStatus.detailKind).toBe("status")
  })
})

describe("mergeTimeline", () => {
  const item = (over: Partial<TimelineItem>): TimelineItem => ({
    id: "x",
    source: "session",
    type: "error",
    label: "l",
    at: 0,
    status: "error",
    ...over,
  })

  it("sorts strictly newest-first across sources", () => {
    const merged = mergeTimeline([
      item({ id: "a", at: 100 }),
      item({ id: "b", at: 300 }),
      item({ id: "c", at: 200 }),
    ])
    expect(merged.map((i) => i.id)).toEqual(["b", "c", "a"])
  })

  it("filters by source", () => {
    const merged = mergeTimeline(
      [
        item({ id: "a", source: "session", at: 1 }),
        item({ id: "b", source: "commit", at: 2 }),
      ],
      { sources: new Set(["commit"]) },
    )
    expect(merged.map((i) => i.id)).toEqual(["b"])
  })

  it("filters by type", () => {
    const merged = mergeTimeline(
      [
        item({ id: "a", type: "assignment", at: 1 }),
        item({ id: "b", type: "run", at: 2 }),
      ],
      { types: new Set(["assignment"]) },
    )
    expect(merged.map((i) => i.id)).toEqual(["a"])
  })

  it("treats an empty filter set as 'all'", () => {
    const items = [item({ id: "a", at: 1 }), item({ id: "b", at: 2 })]
    expect(mergeTimeline(items, { sources: new Set() })).toHaveLength(2)
  })
})

describe("matchesQuery", () => {
  const it0 = (over: Partial<TimelineItem>): TimelineItem => ({
    id: "x",
    source: "commit",
    type: "assignment",
    label: "Create assignment: cs/hw1",
    actor: "teacher",
    detail: "abc1234",
    at: 0,
    status: "info",
    ...over,
  })

  it("matches on label, actor, type, and detail case-insensitively", () => {
    expect(matchesQuery(it0({}), "HW1")).toBe(true)
    expect(matchesQuery(it0({}), "teacher")).toBe(true)
    expect(matchesQuery(it0({}), "assignment")).toBe(true)
    expect(matchesQuery(it0({}), "abc1234")).toBe(true)
  })

  it("returns true for an empty query and false for a non-match", () => {
    expect(matchesQuery(it0({}), "  ")).toBe(true)
    expect(matchesQuery(it0({}), "zzz")).toBe(false)
  })
})

describe("timelineToCsvRows", () => {
  it("maps items to flat rows with ISO time and empty strings for absent fields", () => {
    const rows = timelineToCsvRows([
      {
        id: "a",
        source: "run",
        type: "run",
        label: "Collecting scores",
        at: Date.parse("2026-07-08T10:00:00Z"),
        status: "ok",
      },
    ])
    expect(rows[0]).toEqual({
      time: "2026-07-08T10:00:00.000Z",
      source: "run",
      type: "run",
      status: "ok",
      label: "Collecting scores",
      actor: "",
      detail: "",
      link: "",
    })
  })

  it("neutralizes spreadsheet formula injection in attacker-controlled cells", () => {
    // label/actor/detail come from commit messages and GitHub logins, so a
    // formula-leading value must be quote-prefixed before it can execute on open.
    const rows = timelineToCsvRows([
      {
        id: "x",
        source: "commit",
        type: "config",
        label: '=HYPERLINK("http://evil","click")',
        actor: "+attacker",
        detail: "@SUM(A1)",
        at: 0,
        status: "info",
      },
    ])
    expect(rows[0].label).toBe('\'=HYPERLINK("http://evil","click")')
    expect(rows[0].actor).toBe("'+attacker")
    expect(rows[0].detail).toBe("'@SUM(A1)")
  })
})
