import type { GitHubWorkflowRun } from "@/hooks/github/types"
import type { ActionOperation } from "@/context/actions/ActionActivityProvider"

// Pure helpers behind the activity banner, split out so the run-attribution and
// org-parsing logic is unit-testable without React / the router.

// Reserved top-level URL segments that are not an org slug.
const RESERVED_FIRST_SEGMENTS = new Set(["login"])

// The org slug from a pathname under the `_authed` `<base>/<org>/…` layout.
// `base` is the Vite base path (e.g. "/classroom50" on Pages, "" in dev).
// Returns undefined for the login page and the top-level org picker.
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

// Wall-clock now, as a named import so callers can read the clock inside effects
// without tripping the react-hooks purity rule (which flags a bare `Date.now()`
// in a component/hook body but not a call into an imported function).
export function nowMs(): number {
  return Date.now()
}

// The GitHub Actions run page URL for a run in <org>/classroom50. Built
// deterministically from the run id (the repo is always classroom50), so a
// tracker can keep a stable "View run" link even when a poll transiently omits
// the run object.
export function runUrl(org: string, runId: number): string {
  return `https://github.com/${org}/classroom50/actions/runs/${runId}`
}

// The workflow definition file name (e.g. "publish-pages.yaml") from a run's
// `path` (".github/workflows/publish-pages.yaml").
export function workflowFile(run: GitHubWorkflowRun): string | undefined {
  return run.path?.split("/").pop()
}

// Clock-skew allowance when time-gating a null-baseline dispatch match. The
// op's startedAt is the client wall clock at dispatch; the run's timestamp is
// GitHub's. Allow a generous margin so a small skew doesn't drop the op's own
// run, while still excluding a much-later cron/other-teacher run.
const NULL_BASELINE_SKEW_MS = 60_000

// Whether a run is the one a session operation triggered. A push run
// (publish-pages) matches by head_sha; a dispatch run matches by workflow file +
// a run id newer than the recorded pre-dispatch baseline.
//
// Null-baseline case: when there were no prior dispatch runs of the workflow at
// dispatch time (sinceRunId === null), an id comparison alone would match ANY
// future run of that workflow — so a later nightly cron collect-scores (or
// another teacher's dispatch) could be mis-attributed to this op. Guard it with
// a time lower bound: the run must have started at/after the op's dispatch time
// (minus a skew allowance). Runs missing a timestamp fall back to the id-only
// match (best effort) rather than being dropped.
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

// Resolve the run a session op is tracking from a set of polled runs.
//  - "sha" (push): the run whose head_sha matches.
//  - "sinceRunId" (dispatch): the OLDEST run newer than the baseline for the
//    op's workflow — run ids are monotonic, so the oldest newer run is the one
//    this dispatch created. `claimedRunIds` lets the caller exclude runs already
//    bound to an earlier op, so several same-workflow dispatches each claim a
//    distinct run rather than all binding to the same oldest one.
// Returns null when the op's run hasn't surfaced in the list yet.
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
    // Oldest first (smallest id) — the oldest run newer than the baseline is
    // the one this dispatch created.
    .sort((a, b) => a.id - b.id)
  return candidates[0] ?? null
}

// Attribute a run to a session operation so it gets a specific label. Returns
// the generic label when no session op matches (cron run, another teacher's
// dispatch, or a run from before this session).
export function labelForRun(
  run: GitHubWorkflowRun,
  ops: ActionOperation[],
  _file: string | undefined,
  genericLabel: string,
): string {
  const match = ops.find((op) => runMatchesOp(run, op))
  return match?.label ?? genericLabel
}

// Whether a run is still in flight (not yet completed). Checks `status` first —
// a run is only terminal once GitHub reports status "completed"; queued /
// in_progress / waiting / requested / pending are all "still running".
export function isRunning(run: GitHubWorkflowRun): boolean {
  return run.status !== "completed"
}

// Whether a completed run's `conclusion` counts as a failure the teacher should
// see. `success`, `skipped`, and `neutral` are treated as non-failures; only an
// outright failed/cancelled/timed-out/action_required/stale run flashes error.
// A null conclusion (still running / not yet reported) is not a failure.
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

// The lifecycle phase of a single tracker, evaluated status-first against the
// run it resolved to:
//  - "pending":  no run bound yet (dispatch/commit registered, run not surfaced)
//  - "running":  bound run is still in flight
//  - "failed":   bound run completed with a failure conclusion
//  - "success":  bound run completed cleanly
export type TrackerPhase = "pending" | "running" | "success" | "failed"

export function trackerPhase(run: GitHubWorkflowRun | null): TrackerPhase {
  if (!run) return "pending"
  if (isRunning(run)) return "running"
  return isFailureConclusion(run.conclusion) ? "failed" : "success"
}
