// Normalized display model for the unified org Activity timeline. Three sources
// — the ephemeral session store (ActivityEntry), the classroom50 config-repo
// commit history (GitHubCommit), and Actions workflow runs (GitHubWorkflowRun) —
// each map to a TimelineItem via a pure function here. The page concatenates,
// sorts by `at` desc, and filters. Pure + React-free so the merge logic is
// unit-testable in isolation.

import type { ActivityEntry } from "@/lib/activity/activityStore"
import type { GitHubCommit, GitHubWorkflowRun } from "@/hooks/github/types"
import { COMMIT_PREFIX } from "@/util/commit"
import { runTimes, trackerPhase, workflowFile } from "@/util/actionActivity"

export type TimelineSource = "session" | "commit" | "run"

// A finer classification used for the type filter and the row icon/label.
export type TimelineType =
  | "error"
  | "action"
  | "assignment"
  | "classroom"
  | "student"
  | "scores"
  | "config"
  | "run"

export type TimelineStatus = "ok" | "error" | "running" | "info"

export type TimelineItem = {
  id: string
  source: TimelineSource
  type: TimelineType
  // Human-readable summary (already stripped of the commit prefix, etc.).
  label: string
  // Optional secondary line (endpoint, source location, workflow file, sha).
  detail?: string
  // Who caused it, when known (commit author / run actor). Session items have none.
  actor?: string
  // Epoch ms for sorting + display.
  at: number
  // External link (commit / run on github.com), when available.
  href?: string
  status: TimelineStatus
}

// Classify a config-repo commit by the verb after the "[Classroom 50] " prefix.
// Falls back to "config" for anything unrecognized (still a real config change).
export function classifyConfigCommit(message: string): TimelineType {
  const firstLine = stripPrefix(message).split("\n")[0].toLowerCase()
  if (firstLine.includes("assignment")) return "assignment"
  if (firstLine.includes("classroom")) return "classroom"
  if (firstLine.includes("student")) return "student"
  if (firstLine.includes("score")) return "scores"
  return "config"
}

// Drop the "[Classroom 50] " prefix for display; keep the rest verbatim. A
// non-prefixed commit (e.g. a workflow-authored scores commit) is returned
// unchanged.
function stripPrefix(message: string): string {
  const p = `${COMMIT_PREFIX} `
  return message.startsWith(p) ? message.slice(p.length) : message
}

// First line only — commit bodies are noise in a timeline row.
function firstLine(message: string): string {
  return message.split("\n")[0].trim()
}

function commitTimeMs(commit: GitHubCommit): number {
  const parsed = Date.parse(commit.commit.author?.date ?? "")
  return Number.isNaN(parsed) ? 0 : parsed
}

export function commitToItem(commit: GitHubCommit): TimelineItem {
  const message = commit.commit.message
  return {
    id: `commit-${commit.sha}`,
    source: "commit",
    type: classifyConfigCommit(message),
    label: firstLine(stripPrefix(message)),
    detail: commit.sha.slice(0, 7),
    actor: commit.author?.login ?? commit.commit.author?.name,
    at: commitTimeMs(commit),
    href: commit.html_url,
    status: "info",
  }
}

const runStatusMap = {
  pending: "running",
  running: "running",
  success: "ok",
  failed: "error",
} as const

export function runToItem(
  run: GitHubWorkflowRun,
  labelForFile: (
    file: string | undefined,
    fallback: string | undefined,
  ) => string,
): TimelineItem {
  const { startedAtMs } = runTimes(run)
  const createdMs = Date.parse(run.created_at)
  const phase = trackerPhase(run)
  return {
    id: `run-${run.id}`,
    source: "run",
    type: "run",
    label: labelForFile(workflowFile(run), run.display_title ?? run.name),
    detail: run.event,
    actor: run.triggering_actor?.login,
    at: startedAtMs ?? (Number.isNaN(createdMs) ? 0 : createdMs),
    href: run.html_url,
    status: runStatusMap[phase],
  }
}

export function sessionToItems(entries: ActivityEntry[]): TimelineItem[] {
  return entries.map((e) => ({
    id: `session-${e.id}`,
    source: "session" as const,
    type: e.kind === "error" ? ("error" as const) : ("action" as const),
    label: e.label,
    detail: sessionDetail(e),
    at: e.at,
    href: undefined,
    status: e.kind === "error" ? ("error" as const) : ("info" as const),
  }))
}

function sessionDetail(e: ActivityEntry): string | undefined {
  if (e.endpoint) return e.endpoint
  if (e.source) return `at ${e.source}`
  if (e.status !== undefined) return `HTTP ${e.status}`
  return undefined
}

export type TimelineFilters = {
  // Empty set = all sources / all types.
  sources?: ReadonlySet<TimelineSource>
  types?: ReadonlySet<TimelineType>
}

// Concatenate all source items, filter, and sort newest-first. Stable within
// equal timestamps by id so ordering is deterministic in tests.
export function mergeTimeline(
  items: TimelineItem[],
  filters?: TimelineFilters,
): TimelineItem[] {
  const bySource = filters?.sources
  const byType = filters?.types
  return items
    .filter((i) =>
      bySource && bySource.size > 0 ? bySource.has(i.source) : true,
    )
    .filter((i) => (byType && byType.size > 0 ? byType.has(i.type) : true))
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
}
