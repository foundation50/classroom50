// Normalized display model for the unified org Activity timeline. Three sources
// — the ephemeral session store (ActivityEntry), the classroom50 config-repo
// commit history (GitHubCommit), and Actions workflow runs (GitHubWorkflowRun) —
// each map to a TimelineItem via a pure function here. The page concatenates,
// sorts by `at` desc, and filters. Pure + React-free so the merge logic is
// unit-testable in isolation.

import type { ActivityEntry } from "@/lib/activity/activityStore"
import type { GitHubCommit, GitHubWorkflowRun } from "@/hooks/github/types"
import { COMMIT_PREFIX } from "@/util/commit"
import { escapeCsvFormulaInjection } from "@/util/csv"
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

// How to render `detail`: "endpoint"/"sha"/"event" are shown verbatim; "source"
// and "status" carry a human prefix ("at <loc>", "HTTP <code>") that must be
// translated, so the prefix is applied in the component via t(), not baked into
// this React-free model.
export type TimelineDetailKind =
  "endpoint" | "sha" | "event" | "source" | "status"

export type TimelineItem = {
  id: string
  source: TimelineSource
  type: TimelineType
  // Human-readable summary (already stripped of the commit prefix, etc.).
  label: string
  // Optional secondary line (endpoint, source location, workflow file, sha).
  detail?: string
  // Classifies `detail` so the row can localize prefixed kinds. Absent when
  // there is no detail.
  detailKind?: TimelineDetailKind
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

// Commit author date in epoch ms. GitHub returns config-repo commits
// newest-first and always stamps author.date, so a missing/unparseable date is
// an anomaly (a hand-crafted or malformed commit); float it to "now" so a recent
// change stays near the top of the newest-first timeline rather than sinking to
// the epoch floor and vanishing at the bottom.
function commitTimeMs(commit: GitHubCommit): number {
  const parsed = Date.parse(commit.commit.author?.date ?? "")
  return Number.isNaN(parsed) ? Date.now() : parsed
}

export function commitToItem(commit: GitHubCommit): TimelineItem {
  const message = commit.commit.message
  return {
    id: `commit-${commit.sha}`,
    source: "commit",
    type: classifyConfigCommit(message),
    label: firstLine(stripPrefix(message)),
    detail: commit.sha.slice(0, 7),
    detailKind: "sha",
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
    detailKind: "event",
    actor: run.triggering_actor?.login,
    at: startedAtMs ?? (Number.isNaN(createdMs) ? 0 : createdMs),
    href: run.html_url,
    status: runStatusMap[phase],
  }
}

export function sessionToItems(entries: ActivityEntry[]): TimelineItem[] {
  return entries.map((e) => {
    const { detail, detailKind } = sessionDetail(e)
    return {
      id: `session-${e.id}`,
      source: "session" as const,
      type: e.kind === "error" ? ("error" as const) : ("action" as const),
      label: e.label,
      detail,
      detailKind,
      at: e.at,
      href: undefined,
      status: e.kind === "error" ? ("error" as const) : ("info" as const),
    }
  })
}

// The raw detail value + its kind; the human prefix for "source"/"status" is
// applied in TimelineRow via t() so it stays translatable (this module is
// React-free). endpoint is already a bare URL, shown verbatim.
function sessionDetail(e: ActivityEntry): {
  detail?: string
  detailKind?: TimelineDetailKind
} {
  if (e.endpoint) return { detail: e.endpoint, detailKind: "endpoint" }
  if (e.source) return { detail: e.source, detailKind: "source" }
  if (e.status !== undefined)
    return { detail: String(e.status), detailKind: "status" }
  return {}
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

// Case-insensitive substring match over the fields a user would search: label,
// actor, type, and detail (sha / endpoint / event).
export function matchesQuery(item: TimelineItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [item.label, item.actor, item.type, item.detail].some((field) =>
    field?.toLowerCase().includes(q),
  )
}

// Rows for a CSV export of the timeline (feed to Papa.unparse with header:true).
// ISO timestamp so the export is locale-independent and sortable in a
// spreadsheet; the human columns mirror what the row shows. Free-text cells
// (label, actor, detail) carry attacker-influenceable text — commit messages and
// GitHub logins — so they're formula-guarded (OWASP CSV injection) before export.
export type TimelineCsvRow = {
  time: string
  source: TimelineSource
  type: TimelineType
  status: TimelineStatus
  label: string
  actor: string
  detail: string
  link: string
}

export function timelineToCsvRows(items: TimelineItem[]): TimelineCsvRow[] {
  return items.map((i) => ({
    time: new Date(i.at).toISOString(),
    source: i.source,
    type: i.type,
    status: i.status,
    label: escapeCsvFormulaInjection(i.label),
    actor: escapeCsvFormulaInjection(i.actor ?? ""),
    detail: escapeCsvFormulaInjection(i.detail ?? ""),
    link: i.href ?? "",
  }))
}
