import type { GitHubClient } from "@/github-core/client"
import { getClassroomJson } from "@/github-core/configRepoReads"
import { GitHubAPIError } from "@/github-core/errors"
import { withRetry } from "@/github-core/queries"
import { isClassroomArchived } from "@/types/classroom"

// Refuse a write into an archived classroom (active: false). The UI hides the
// affordances, but the write path is the authoritative guard (stale tab, direct
// API call, CLI/agent). Reads classroom.json fresh and fails closed before any
// commit; a missing/legacy classroom.json reads as active.
export async function assertClassroomNotArchived(
  client: GitHubClient,
  org: string,
  classroom: string,
) {
  let classroomJson
  try {
    classroomJson = await readClassroomJsonForGuard(client, org, classroom)
  } catch (err) {
    // A missing/legacy classroom.json reads as active — never block.
    if (err instanceof GitHubAPIError && err.isNotFound) return
    // A transient read failure (rate-limit / 5xx / network) can't prove the
    // classroom's state. Stay fail-closed, but surface an actionable message
    // instead of bubbling the raw GitHub error as if the write itself failed.
    if (isTransientReadError(err)) {
      throw new Error(
        `Couldn't verify whether classroom "${classroom}" is archived (a temporary problem reading its settings). Please try again.`,
        { cause: err },
      )
    }
    throw err
  }
  if (isClassroomArchived(classroomJson)) {
    throw new Error(
      `Classroom "${classroom}" is archived — changes are disabled. Unarchive it in Classroom settings first.`,
    )
  }
}

// A transient read can't determine archive state and shouldn't fail-closed on
// the first blip; retry once before giving up so a single rate-limit/5xx/network
// hiccup doesn't block an otherwise-valid mutation.
function readClassroomJsonForGuard(
  client: GitHubClient,
  org: string,
  classroom: string,
) {
  return withRetry(() => getClassroomJson(client, { org, classroom }), {
    attempts: 2,
    shouldRetry: isTransientReadError,
    waitMs: () => 300,
  })
}

// Errors that don't prove the classroom's state: rate limiting, 5xx, and
// non-HTTP (network) failures. A 404 is determinate (handled by the caller as
// legacy/active) and is therefore NOT transient.
function isTransientReadError(err: unknown): boolean {
  if (err instanceof GitHubAPIError) return err.isTransient
  // A thrown non-GitHubAPIError here is a network/parse failure, not a
  // determinate API answer — treat as transient.
  return err instanceof Error
}
