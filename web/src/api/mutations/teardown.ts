// Org teardown — the web mirror of the CLI's `gh teacher teardown` (delete
// every repo in the org, marker-gated, marker deleted last). Mirrors the CLI's
// scope decision (ALL org repos, not a leaky managed-only filter) and safety
// model. Also removes the per-classroom team of every classroom in the org's
// classroom.json so repo deletion doesn't orphan those teams. Destructive and
// irreversible — the caller gates it behind a typed-org-name ConfirmModal that
// lists exactly what will be deleted.

import type { GitHubClient } from "@/github-core/client"
import { getClassroomJson } from "@/github-core/configRepoReads"
import { GitHubAPIError } from "@/github-core/errors"
import {
  deleteClassroomTeam,
  deleteRepo,
  isDeletableClassroomTeamRef,
  type ClassroomTeamRef,
} from "@/github-core/mutations"
import {
  getOrgRepos,
  listClassroomDirs,
  REPO_READ_CONCURRENCY,
  sleep,
} from "@/github-core/queries"
import { getRepo } from "@/github-core/repoReads"
import { CONFIG_REPO } from "@/util/configRepo"
import { mapWithConcurrency } from "@/util/concurrency"
import { logger } from "@/lib/logger"

const log = logger.scope("mutations:teardown")

export class TeardownScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TeardownScopeError"
  }
}

export class TeardownMarkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TeardownMarkerError"
  }
}

// A secondary rate limit aborted the run. Distinct from TeardownScopeError so
// the UI can offer a retry, and carries partial progress for reporting.
export class TeardownRateLimitError extends Error {
  deleted: string[]
  failed: string[]
  constructor(deleted: string[], failed: string[]) {
    super(
      "Hit a GitHub rate limit while deleting repositories. Some repositories may already be deleted; wait a moment and re-run teardown to finish.",
    )
    this.name = "TeardownRateLimitError"
    this.deleted = deleted
    this.failed = failed
  }
}

export type TeardownPlan = {
  org: string
  repoNames: string[]
  // Per-classroom teams to delete, resolved from each classroom's classroom.json
  // (deduped by slug). Surfaced so the confirm UI lists exactly what's removed.
  // Only teams a classroom actually links to are deleted — a manually created
  // team is never touched, even if it shares the classroom50- naming.
  teams: ClassroomTeamRef[]
}

// Read each classroom's classroom.json and collect its team ref, deduped by
// slug. Per-classroom reads are best-effort: a classroom with no team block
// (pre-feature) or an unreadable classroom.json contributes no ref, so one bad
// file never blocks the rest of teardown. classroom.json lives in the marker
// repo, so this must run before the marker is deleted.
async function collectClassroomTeams(
  client: GitHubClient,
  org: string,
): Promise<ClassroomTeamRef[]> {
  let dirs: { name: string }[]
  try {
    dirs = await listClassroomDirs(client, org)
  } catch {
    log.debug(
      "teardown: no readable classroom dirs, skipping team collection",
      {
        org,
      },
    )
    // No readable classroom dirs (e.g. marker already partially gone) — nothing
    // to resolve; let the repo flow proceed.
    return []
  }

  const bySlug = new Map<string, ClassroomTeamRef>()
  await mapWithConcurrency(dirs, REPO_READ_CONCURRENCY, async (dir) => {
    try {
      const json = await getClassroomJson(client, { org, classroom: dir.name })
      // classroom.json is anyone-with-config-repo-write authored and parsed
      // without schema validation, so its team refs are untrusted input to a
      // destructive bulk DELETE. Only queue refs the app owns and can safely
      // delete — see isDeletableClassroomTeamRef.
      const candidates = [json.team, json.teams?.instructor, json.teams?.ta]
      for (const team of candidates) {
        if (isDeletableClassroomTeamRef(team)) {
          bySlug.set(team.slug, { id: team.id, slug: team.slug })
        }
      }
    } catch {
      log.debug("teardown: classroom.json unreadable, no team ref", {
        org,
        classroom: dir.name,
      })
      // Missing/unreadable classroom.json or no team block: contributes nothing.
    }
  })

  return [...bySlug.values()]
}

// Enumerate the deletion plan: every repo in the org (marker last so an
// interrupted run leaves the marker behind, re-runnable) plus the per-classroom
// teams resolved from classroom.json. Refuses an org without the classroom50
// marker repo.
export async function planTeardown(
  client: GitHubClient,
  org: string,
): Promise<TeardownPlan> {
  const marker = await getRepo(client, org, CONFIG_REPO)
  if (!marker) {
    throw new TeardownMarkerError(
      `${org}/${CONFIG_REPO} not found — refusing teardown on an org without the Classroom 50 marker repo.`,
    )
  }

  const repos = await getOrgRepos(client, org)
  const names = (repos ?? []).map((r) => r.name)
  const nonMarker = names.filter((n) => n !== CONFIG_REPO)
  const teams = await collectClassroomTeams(client, org)
  // Marker last so a partial run stays re-runnable.
  return { org, repoNames: [...nonMarker, CONFIG_REPO], teams }
}

export type TeardownResult = {
  deleted: string[]
  failed: string[]
  // Per-classroom team slugs removed during this run.
  teamsDeleted: string[]
  // Team slugs that could not be deleted (run stays re-runnable).
  teamsFailed: string[]
  // Whether the marker repo (classroom50) was deleted this run. False means it
  // was retained because something recoverable failed, so the org stays
  // re-runnable; true means teardown finished the marker and a re-run would
  // refuse on the now-missing marker (leftover teams must be removed by hand).
  // The UI's remedy message keys off this.
  markerDeleted: boolean
}

const MAX_DELETE_ATTEMPTS = 4

const DELETE_SCOPE_MESSAGE =
  "Deleting repositories was forbidden (403). Teardown needs the `delete_repo` OAuth scope, which is not granted by default. Re-authenticate with that scope, or archive repositories instead."

// "1 repository" / "3 repositories" — count + correctly-pluralized noun.
function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

// Terminal disposition of a bounded-retry delete:
//  - "deleted": gone (or already gone via 404).
//  - "rate-limited": exhausted retries while throttled — recoverable, retry later.
//  - "transient-failed": exhausted retries on a non-throttle transient error
//    (e.g. 5xx) — recoverable, a re-run may succeed.
//  - "permanent-failed": an unretryable refusal a re-run will repeat forever
//    (a reused-slug id mismatch, or a scope 403 a caller chose not to rethrow).
type DeleteOutcome =
  "deleted" | "rate-limited" | "transient-failed" | "permanent-failed"

// How withDeleteRetry should treat an error that is not a rate limit:
//  - "rethrow": propagate it now (the caller surfaces a scope wall).
//  - "permanent": stop retrying and report "permanent-failed".
//  - null: treat as transient and keep retrying.
type UnretryableDisposition = "rethrow" | "permanent" | null

// Shared bounded-retry loop for destructive deletes (repos and teams). Owns the
// attempt count, exponential backoff + jitter, and Retry-After honoring; the
// only per-caller policy is `classifyUnretryable`, deciding what to do with a
// non-rate-limit error. Factored out so repo and team deletes can't drift in
// backoff/retry behavior.
async function withDeleteRetry(
  deleteFn: () => Promise<void>,
  classifyUnretryable: (
    err: GitHubAPIError,
  ) => Exclude<UnretryableDisposition, null> | null,
): Promise<DeleteOutcome> {
  let lastWasRateLimit = false
  for (let attempt = 0; attempt < MAX_DELETE_ATTEMPTS; attempt++) {
    try {
      await deleteFn()
      return "deleted"
    } catch (err) {
      const isRateLimited = err instanceof GitHubAPIError && err.isRateLimited
      lastWasRateLimit = isRateLimited

      // A non-GitHubAPIError (e.g. the id-mismatch guard) can never succeed on
      // retry: a permanent refusal.
      if (!(err instanceof GitHubAPIError)) return "permanent-failed"

      if (!isRateLimited) {
        const disposition = classifyUnretryable(err)
        if (disposition === "rethrow") throw err
        if (disposition === "permanent") return "permanent-failed"
      }

      const isLastAttempt = attempt === MAX_DELETE_ATTEMPTS - 1
      if (isLastAttempt) {
        return isRateLimited ? "rate-limited" : "transient-failed"
      }

      // Back off before retrying: honor Retry-After when present, else
      // exponential backoff with jitter capped at ~8s.
      const retryAfterMs =
        err.rateLimit.retryAfter !== null ? err.rateLimit.retryAfter * 1000 : 0
      const backoffMs = Math.min(8000, 500 * 2 ** attempt)
      const jitterMs = Math.floor(Math.random() * 250)
      log.debug("teardown: delete retry backoff", {
        attempt,
        rateLimited: isRateLimited,
      })
      await sleep(Math.max(retryAfterMs, backoffMs) + jitterMs)
    }
  }
  return lastWasRateLimit ? "rate-limited" : "transient-failed"
}

// Delete one repo, retrying transient failures (rate limits, 5xx). A scope 403
// (not a rate limit) is unretryable and rethrown so the caller can surface the
// scope wall.
function deleteRepoWithRetry(
  client: GitHubClient,
  org: string,
  repo: string,
): Promise<DeleteOutcome> {
  return withDeleteRetry(
    () => deleteRepo(client, { owner: org, repo }),
    (err) => (err.isForbidden ? "rethrow" : null),
  )
}

// Delete one classroom team (by its persisted { id, slug }), retrying transient
// failures like repo deletes do. Uses deleteClassroomTeam, which confirms the
// live team's id matches the persisted id before deleting (so a reused slug
// isn't clobbered) and treats 404 as already-gone. A scope/permission 403 (the
// team-delete path swallows rather than rethrows the scope wall) and an id
// mismatch are permanent refusals: recorded without retrying.
function deleteClassroomTeamWithRetry(
  client: GitHubClient,
  org: string,
  team: ClassroomTeamRef,
): Promise<DeleteOutcome> {
  return withDeleteRetry(
    () => deleteClassroomTeam(client, org, team),
    (err) => (err.isForbidden ? "permanent" : null),
  )
}

// Delete the per-classroom teams resolved from classroom.json. Best-effort: a
// failure is recorded but never aborts teardown, mirroring the repo flow's
// re-runnable contract. A *recoverable* failure (throttle or transient 5xx) is
// reported separately (teamsRecoverable): unlike a permanent refusal it can
// succeed on a re-run, so the caller retains the marker repo (which holds
// classroom.json, the only team-ref source) rather than orphaning a team a
// re-run would have cleaned up. A permanent refusal (reused-slug id mismatch,
// or a scope 403) lands in teamsFailed and does NOT retain the marker — a
// re-run would just refuse it again.
async function deleteClassroomTeams(
  client: GitHubClient,
  org: string,
  teams: ClassroomTeamRef[],
): Promise<{
  teamsDeleted: string[]
  teamsFailed: string[]
  teamsRecoverable: boolean
}> {
  const teamsDeleted: string[] = []
  const teamsFailed: string[] = []
  let teamsRecoverable = false

  await mapWithConcurrency(teams, 4, async (team) => {
    const outcome = await deleteClassroomTeamWithRetry(client, org, team)
    if (outcome === "deleted") {
      teamsDeleted.push(team.slug)
    } else {
      if (outcome === "rate-limited" || outcome === "transient-failed") {
        teamsRecoverable = true
      }
      teamsFailed.push(team.slug)
    }
  })

  return { teamsDeleted, teamsFailed, teamsRecoverable }
}

// Execute the teardown plan with bounded concurrency, marker last. A scope 403
// surfaces TeardownScopeError; a rate-limit 403 surfaces a retryable
// TeardownRateLimitError. The marker is deleted only when every non-marker
// delete succeeded, so a partial failure stays re-runnable.
//
// The repo set is re-enumerated here, not taken from plan.repoNames: the plan
// is captured when the confirm modal opens, but a repo can be created during
// the type-to-confirm pause. Re-listing keeps the "delete every repo" guarantee
// against the live org and re-checks the marker gate.
export async function executeTeardown(
  client: GitHubClient,
  plan: TeardownPlan,
): Promise<TeardownResult> {
  const deleted: string[] = []
  const failed: string[] = []

  const current = await planTeardown(client, plan.org)
  const nonMarker = current.repoNames.filter((n) => n !== CONFIG_REPO)
  const marker = current.repoNames.filter((n) => n === CONFIG_REPO)

  log.warn("teardown: STARTED (destructive, irreversible)", {
    org: plan.org,
    repos: nonMarker.length,
    teams: current.teams.length,
    record: true,
  })

  let scopeWall = false
  let rateLimited = false

  const tryDelete = async (repo: string) => {
    try {
      const outcome = await deleteRepoWithRetry(client, plan.org, repo)
      if (outcome === "deleted") {
        log.info("teardown: repo deleted", { org: plan.org, repo })
        deleted.push(repo)
      } else {
        // Retries exhausted: a throttle is retryable; other transient failures
        // (5xx) go to `failed` so the marker is preserved (re-runnable). Repos
        // never see "permanent-failed" — a scope 403 rethrows below instead.
        if (outcome === "rate-limited") rateLimited = true
        log.warn("teardown: repo delete failed", {
          org: plan.org,
          repo,
          outcome,
        })
        failed.push(repo)
      }
    } catch (err) {
      // deleteRepoWithRetry only throws for an unretryable scope 403.
      if (err instanceof GitHubAPIError && err.isForbidden) {
        scopeWall = true
      }
      log.error("teardown: repo delete errored", {
        org: plan.org,
        repo,
        err,
      })
      failed.push(repo)
    }
  }

  await mapWithConcurrency(nonMarker, 4, tryDelete)

  // A scope 403 is unrecoverable; a throttle is retryable. Both abort before
  // the marker so the run stays re-runnable.
  const abortIfBlocked = () => {
    if (scopeWall) {
      log.error("teardown aborted: missing delete_repo scope", {
        org: plan.org,
        deleted: deleted.length,
        failed: failed.length,
        record: true,
      })
      throw new TeardownScopeError(DELETE_SCOPE_MESSAGE)
    }
    if (rateLimited) {
      log.warn("teardown aborted: rate limited (re-runnable)", {
        org: plan.org,
        deleted: deleted.length,
        failed: failed.length,
        record: true,
      })
      throw new TeardownRateLimitError(deleted, failed)
    }
  }

  abortIfBlocked()

  // Remove the per-classroom teams BEFORE the marker repo is deleted —
  // classroom.json (the team-ref source) lives in the marker repo, so reading it
  // after would be impossible. `current.teams` was resolved fresh by the
  // re-enumerating planTeardown above (not the stale modal plan). Best-effort: a
  // team failure never blocks the marker.
  const { teamsDeleted, teamsFailed, teamsRecoverable } =
    await deleteClassroomTeams(client, plan.org, current.teams)

  // Marker deleted only on a fully-successful run; otherwise left behind so
  // planTeardown's gate still passes and the run stays re-runnable. A
  // *recoverable* team failure (throttle or transient 5xx) retains the marker
  // too, so a re-run can re-resolve classroom.json and finish the team; a
  // *permanent* refusal (reused-slug id mismatch, scope 403) does not — a re-run
  // would just repeat it and wedge teardown forever.
  const retainMarker = failed.length > 0 || rateLimited || teamsRecoverable
  let markerDeleted = false
  if (!retainMarker) {
    for (const repo of marker) {
      await tryDelete(repo)
    }
    abortIfBlocked()
    markerDeleted = deleted.includes(CONFIG_REPO)
    if (markerDeleted) {
      log.info("teardown: marker repo deleted", { org: plan.org })
    }
  }

  log.warn("teardown: completed", {
    org: plan.org,
    deleted: deleted.length,
    failed: failed.length,
    teamsDeleted: teamsDeleted.length,
    teamsFailed: teamsFailed.length,
    markerDeleted,
    record: true,
  })

  return { deleted, failed, teamsDeleted, teamsFailed, markerDeleted }
}

// Build the human success/partial message for a completed teardown run. Pure
// and exported so the message logic (counts, pluralization, remedy) is
// unit-testable without the React component. `orgTeamsUrl` is the org's teams
// settings URL used in the "remove by hand" remedy.
export function formatTeardownResult(
  result: TeardownResult,
  orgTeamsUrl: string,
): string {
  const repos = countLabel(result.deleted.length, "repository", "repositories")
  const teams =
    result.teamsDeleted.length > 0
      ? ` and ${countLabel(result.teamsDeleted.length, "classroom team", "classroom teams")}`
      : ""

  const anyFailed = result.failed.length > 0 || result.teamsFailed.length > 0
  if (!anyFailed) {
    return `Deleted ${repos}${teams}.`
  }

  const failedParts = [
    result.failed.length > 0
      ? countLabel(result.failed.length, "repository", "repositories")
      : "",
    result.teamsFailed.length > 0
      ? countLabel(result.teamsFailed.length, "team", "teams")
      : "",
  ].filter(Boolean)

  // The marker is the team-ref source (classroom.json). If still present, a
  // re-run can finish the job; if gone, a re-run would refuse on the missing
  // marker, so any leftover teams must be removed by hand.
  const remedy = !result.markerDeleted
    ? "Re-run teardown to finish."
    : `Remove the leftover ${result.teamsFailed.length === 1 ? "team" : "teams"} by hand at ${orgTeamsUrl}.`

  return `Deleted ${repos}${teams}; ${failedParts.join(" and ")} could not be deleted. ${remedy}`
}
