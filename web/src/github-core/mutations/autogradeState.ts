// Pause/resume a student repo's autograding by flipping the autograde workflow's
// GitHub Actions state — NOT by editing the shim file. GitHub evaluates a
// workflow's `active` state independently of its `on:` triggers, so
// disable/enable stops (or restores) grading without touching
// .github/workflows/autograde.yaml, every other workflow, or any student file.
// This needs only the `repo` scope, unlike the shim file-surgery path
// (submissionTrigger.ts), which needs the `workflow` scope to write the file.
import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"

// GitHub addresses a workflow by numeric id OR file name; the file name keeps us
// off a list-workflows lookup. This is the basename of the shim path — byte-
// mirror of domain/assignments/submissionTrigger's AUTOGRADE_SHIM_PATH
// (".github/workflows/autograde.yaml"), duplicated here because github-core is
// the lowest data layer and must not import domain (github-core-not-up). Keep
// in lockstep with that constant and its Go/Python twins.
export const AUTOGRADE_WORKFLOW_FILE = "autograde.yaml"

// The teacher-facing autograding state, derived from the workflow's GitHub state.
//  - enabled       → workflow active, grading runs (offer Pause)
//  - paused        → teacher-disabled (disabled_manually) (offer Resume)
//  - pausedByGitHub → disabled_fork/_inactivity: GitHub disabled it, not the
//    teacher; Resume (enable) is still the correct remediation
//  - notGradable   → no autograde workflow (empty_repo/no_autograder/custom, or
//    repo not accepted yet) — a first-class non-error state, not a failure
export type AutogradeState =
  "enabled" | "paused" | "pausedByGitHub" | "notGradable"

// Map GitHub's workflow `state` enum onto the teacher-facing state.
function toAutogradeState(githubState: string): AutogradeState {
  switch (githubState) {
    case "active":
      return "enabled"
    case "disabled_manually":
      return "paused"
    case "disabled_fork":
    case "disabled_inactivity":
      return "pausedByGitHub"
    // "deleted" (and any unknown future value) means nothing to grade.
    default:
      return "notGradable"
  }
}

// Read the autograde workflow's state for one repo. A 404 (no such workflow, or
// repo not accepted yet) is the notGradable state, not an error. Other errors
// propagate so a caller can bucket rate-limit/permission failures.
export async function getAutogradeState(params: {
  client: GitHubClient
  org: string
  repo: string
}): Promise<AutogradeState> {
  const { client, org, repo } = params
  try {
    const wf = await client.request<{ state?: string }>(
      `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/actions/workflows/${AUTOGRADE_WORKFLOW_FILE}`,
    )
    return toAutogradeState(wf.state ?? "")
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return "notGradable"
    throw err
  }
}

// Pause (disable) or resume (enable) autograding for one repo. Both endpoints
// return 204 and are idempotent — enabling an already-active workflow (or
// disabling an already-paused one) is a no-op success, so callers don't need a
// pre-read. A 404 means the repo has no autograde workflow; surfaced as its own
// outcome so the UI can distinguish "nothing to pause" from a real failure.
export async function setAutogradeState(params: {
  client: GitHubClient
  org: string
  repo: string
  action: "pause" | "resume"
}): Promise<{ status: "ok" | "notGradable" }> {
  const { client, org, repo, action } = params
  const verb = action === "pause" ? "disable" : "enable"
  try {
    await client.request(
      `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/actions/workflows/${AUTOGRADE_WORKFLOW_FILE}/${verb}`,
      { method: "PUT" },
    )
    return { status: "ok" }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      return { status: "notGradable" }
    }
    throw err
  }
}
