import type { GitHubWorkflowRun } from "@/hooks/github/types"
import type { ActionOperation } from "@/context/actions/ActionActivityProvider"
import { CONFIG_REPO } from "@/util/configRepo"

// Pure helpers behind the activity banner, split out so run-attribution and
// org-parsing are testable without React / the router.

// Reserved top-level URL segments that aren't an org slug.
const RESERVED_FIRST_SEGMENTS = new Set(["login"])

// The org slug from a pathname under the `<base>/<org>/…` layout (`base` is the
// Vite base path). Undefined for the login page and the org picker.
export function orgFromPathname(
  pathname: string,
  base: string,
): string | undefined {
  const trimmedBase = base.replace(/\/$/, "")
  let rest = pathname
  if (trimmedBase && rest.startsWith(trimmedBase)) {
    rest = rest.slice(trimmedBase.length)
  }
  const segments = rest.split("/").filter(Boolean)
  const first = segments[0]
  if (!first || RESERVED_FIRST_SEGMENTS.has(first)) return undefined
  return decodeURIComponent(first)
}

// Wall-clock now via a named import, so callers can read the clock inside
// effects without tripping the react-hooks purity rule (bare `Date.now()` in a
// hook body is flagged, an imported call isn't).
export function nowMs(): number {
  return Date.now()
}

// The run page URL for a run in <org>/classroom50, built from the run id so a
// tracker keeps a stable "View run" link even when a poll omits the run object.
export function runUrl(org: string, runId: number): string {
  return `https://github.com/${org}/${CONFIG_REPO}/actions/runs/${runId}`
}

// Parse an ISO timestamp to epoch ms, or undefined when absent/unparseable.
function parseMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : ms
}

// Start/end epoch-ms for a run's elapsed time. Start = run_started_at (else
// created_at); end = updated_at only once completed (a running run has no end).
export function runTimes(run: GitHubWorkflowRun): {
  startedAtMs?: number
  endedAtMs?: number
} {
  const startedAtMs = parseMs(run.run_started_at) ?? parseMs(run.created_at)
  const endedAtMs =
    run.status === "completed" ? parseMs(run.updated_at) : undefined
  return { startedAtMs, endedAtMs }
}

// Workflow file name (e.g. "publish-pages.yaml") from a run's `path`.
export function workflowFile(run: GitHubWorkflowRun): string | undefined {
  return run.path?.split("/").pop()
}

// Clock-skew allowance for the null-baseline dispatch time-gate: the op's
// startedAt is the client clock, the run's timestamp is GitHub's.
const NULL_BASELINE_SKEW_MS = 60_000

// Whether a run is the one an op triggered. A push run matches by head_sha; a
// dispatch run matches by workflow file + a run id past the pre-dispatch
// baseline.
//
// Null-baseline (no prior dispatch runs at dispatch time): an id comparison
// alone would match ANY future run, mis-attributing a later cron/other run — so
// gate on the run having started at/after the dispatch (with skew). A run
// missing a timestamp falls back to id-only.
export function runMatchesOp(
  run: GitHubWorkflowRun,
  op: ActionOperation,
): boolean {
  if (op.anchor.kind === "sha") {
    return Boolean(run.head_sha && run.head_sha === op.anchor.sha)
  }
  if (workflowFile(run) !== op.anchor.workflow) return false
  if (op.anchor.sinceRunId !== null) return run.id > op.anchor.sinceRunId

  // Null baseline: accept any run of the workflow that started no earlier than
  // the dispatch (with skew). Without a run timestamp, fall back to accepting.
  const stamp = run.run_started_at ?? run.created_at
  if (!stamp) return true
  const startedMs = Date.parse(stamp)
  if (Number.isNaN(startedMs)) return true
  return startedMs >= op.startedAt - NULL_BASELINE_SKEW_MS
}

// Resolve the run an op is tracking from the polled runs. "sha" -> matching
// head_sha; "sinceRunId" -> the OLDEST run past the baseline (ids are
// monotonic). `claimedRunIds` excludes runs already bound to an earlier op, so
// racing same-workflow dispatches each claim a distinct run.
export function resolveOpRun(
  op: ActionOperation,
  runs: GitHubWorkflowRun[],
  claimedRunIds?: ReadonlySet<number>,
): GitHubWorkflowRun | null {
  if (op.anchor.kind === "sha") {
    return runs.find((r) => runMatchesOp(r, op)) ?? null
  }
  const candidates = runs
    .filter((r) => runMatchesOp(r, op))
    .filter((r) => !claimedRunIds?.has(r.id))
    // Oldest run past the baseline is the one this dispatch created.
    .sort((a, b) => a.id - b.id)
  return candidates[0] ?? null
}

// Whether a run is still in flight — terminal only once status is "completed"
// (queued/in_progress/waiting/requested/pending all count as running).
export function isRunning(run: GitHubWorkflowRun): boolean {
  return run.status !== "completed"
}

// Whether a completed run's conclusion is a failure the teacher should see.
// success/skipped/neutral (and null) are non-failures.
export function isFailureConclusion(
  conclusion: GitHubWorkflowRun["conclusion"],
): boolean {
  return (
    conclusion === "failure" ||
    conclusion === "cancelled" ||
    conclusion === "timed_out" ||
    conclusion === "action_required" ||
    conclusion === "stale"
  )
}

// A tracker's lifecycle phase, evaluated status-first: pending (no run bound),
// running (in flight), failed / success (completed).
export type TrackerPhase = "pending" | "running" | "success" | "failed"

export function trackerPhase(run: GitHubWorkflowRun | null): TrackerPhase {
  if (!run) return "pending"
  if (isRunning(run)) return "running"
  return isFailureConclusion(run.conclusion) ? "failed" : "success"
}

// The i18n key that wraps a base action label for a given phase, so the banner
// text (and thus the aria-live announcement) reflects state, not just the icon
// — a screen-reader user hears "…done" / "…failed", not the same string twice.
export const PHASE_LABEL_KEY: Record<TrackerPhase, string> = {
  pending: "actionsBanner.state.pending",
  running: "actionsBanner.state.running",
  success: "actionsBanner.state.success",
  failed: "actionsBanner.state.failed",
}
