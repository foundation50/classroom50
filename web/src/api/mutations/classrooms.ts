import type { GitHubClient } from "@/hooks/github/client"
import { GitHubAPIError } from "@/hooks/github/errors"
import type { GitHubMoveBranch } from "@/hooks/github/types"
import { getBranchRef, getClassroomJson, getCommit } from "../github/queries"
import { sleep } from "@/hooks/github/queries"
import { isClassroomArchived } from "@/types/classroom"
import {
  createCommit,
  createTree,
  deleteClassroomTeam,
  editClassroom,
  ensureClassroomTeam,
  ensureStaffTeams,
  addUserToTeam,
  isDeletableClassroomTeamRef,
  isNonFastForward,
  updateRef,
  type ClassroomTeamRef,
  type EditClassroomInput,
  type GitTreeEntry,
  type GitTreeFileMode,
  type StaffTeamRefs,
} from "@/hooks/github/mutations"
import { prefixCommit } from "@/util/commit"
import { logger } from "@/lib/logger"

const log = logger.scope("mutations:classrooms")

export type CreateClassroomResult = {
  previousCommitSha: string
  baseTreeSha: string
  newTreeSha: string
  newCommitSha: string
  updatedRef: GitHubMoveBranch
}
export async function createClassroomFiles(
  client: GitHubClient,
  input: CreateClassroomInput,
): Promise<CreateClassroomResult> {
  log.info("create classroom: started", {
    org: input.org,
    classroom: input.classroom,
  })
  // Create (or adopt) the teams BEFORE scaffolding so their { id, slug } land in
  // classroom.json (mirrors the CLI). The students team grants rostered students
  // read on private org templates; the staff teams (instructor, ta) get
  // config-repo write and back the in-app roles.
  const { created: teamCreated, ...team } = await ensureClassroomTeam(
    client,
    input.org,
    input.classroom,
  )
  const { teams, created: staffCreated } = await ensureStaffTeams(
    client,
    input.org,
    input.classroom,
  )

  // The creator becomes an instructor (the only way to seed staff membership in
  // a serverless app). Best-effort: a membership hiccup must not fail creation —
  // an owner can re-add via the roster UI.
  if (input.creator && teams.instructor) {
    try {
      await addUserToTeam(client, {
        org: input.org,
        teamSlug: teams.instructor.slug,
        username: input.creator,
        role: "maintainer",
      })
    } catch {
      log.warn("create classroom: seeding creator as instructor failed", {
        org: input.org,
        classroom: input.classroom,
        creator: input.creator,
      })
      // Non-fatal; surface nothing — the classroom still scaffolds.
    }
  }

  // If scaffolding fails after the teams exist, any team we CREATED would be
  // orphaned — best-effort delete them before re-throwing. Never delete an
  // ADOPTED team. A 409 (concurrent commit) is re-thrown untouched so
  // withGitConflictRetry can re-run, whose ensure* calls then adopt the
  // just-created teams rather than deleting them out from under the retry.
  let ref, commit, tree, newCommit, updatedRef
  try {
    ref = await getBranchRef(client, input.org)
    commit = await getCommit(client, input.org, ref.object.sha)
    tree = await createTree(client, {
      ...input,
      base_tree: commit.tree.sha,
      term: input.term,
      team,
      teams,
    })
    newCommit = await createCommit(client, {
      ...input,
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })
    updatedRef = await updateRef(client, input.org, newCommit.sha)
  } catch (err) {
    if (!(err instanceof GitHubAPIError && err.status === 409)) {
      log.warn("create classroom: scaffolding failed, rolling back teams", {
        org: input.org,
        classroom: input.classroom,
        err,
      })
      await rollbackCreatedTeams(client, input.org, {
        students: teamCreated ? team : undefined,
        staff: teams,
        staffCreated,
      })
    }
    throw err
  }

  log.info("create classroom: completed", {
    org: input.org,
    classroom: input.classroom,
  })

  return {
    previousCommitSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    newTreeSha: tree.sha,
    newCommitSha: newCommit.sha,
    updatedRef,
  }
}

// Best-effort rollback of teams THIS run created (never adopted ones) after a
// scaffolding failure. Each delete is swallowed so the original error surfaces.
async function rollbackCreatedTeams(
  client: GitHubClient,
  org: string,
  args: {
    students?: { id: number; slug: string }
    staff: StaffTeamRefs
    staffCreated: ReadonlyArray<"instructor" | "ta">
  },
): Promise<void> {
  const toDelete = [
    args.students,
    ...args.staffCreated.map((role) => args.staff[role]),
  ].filter((t): t is { id: number; slug: string } => Boolean(t?.slug))

  for (const t of toDelete) {
    try {
      await deleteClassroomTeam(client, org, t)
    } catch {
      log.warn("rollback: team delete failed (best-effort)", {
        org,
        teamSlug: t.slug,
      })
      // Best-effort cleanup; surface the original scaffolding error.
    }
  }
}

export async function withGitConflictRetry<T>(
  fn: () => Promise<T>,
): Promise<T> {
  // A concurrent write to classroom50 main conflicts the updateRef: GitHub
  // returns 409, or a 422 "not a fast forward" when the force:false ref PATCH
  // loses the race. fn re-reads the ref + file each attempt, so retrying either
  // is safe; jittered backoff lets the winning write land and avoids lock-step
  // collisions between racing clients.
  const attempts = 4
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const isConflict =
        (err instanceof GitHubAPIError && err.status === 409) ||
        isNonFastForward(err)
      if (!isConflict || attempt === attempts) {
        throw err
      }
      log.debug("git conflict, retrying commit", { attempt })
      await sleep(300 * attempt + Math.random() * 400)
    }
  }

  throw lastError
}

export type CreateClassroomInput = {
  org: string
  name?: string
  classroom: string
  term: string
  // Optional capability-URL secret (opt-in). When set, classroom.json records
  // it and published Pages resources live under `<classroom>/<secret>/...`.
  // Validated to `[a-z0-9]{4,64}` before the mutation runs.
  secret?: string
  // The viewer's GitHub login, added to the instructor staff team on create so
  // the creator gets the instructor role. Optional — the classroom still
  // scaffolds without it.
  creator?: string
}
export async function createClassroomFilesWithConflictRetry(
  client: GitHubClient,
  input: CreateClassroomInput,
) {
  return withGitConflictRetry(() => createClassroomFiles(client, input))
}

// Refuse a write into an archived classroom (active: false). The UI hides the
// affordances, but the write path is the authoritative guard (stale tab, direct
// API call, CLI/agent). Reads classroom.json fresh and fails closed before any
// commit; a missing/legacy classroom.json reads as active. Shared by the
// assignment and roster mutations.
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
      `Classroom "${classroom}" is archived — changes are disabled. Unarchive it in Classroom Settings first.`,
    )
  }
}

// A transient read can't determine archive state and shouldn't fail-closed on
// the first blip; retry once before giving up so a single rate-limit/5xx/network
// hiccup doesn't block an otherwise-valid mutation.
async function readClassroomJsonForGuard(
  client: GitHubClient,
  org: string,
  classroom: string,
) {
  try {
    return await getClassroomJson(client, { org, classroom })
  } catch (err) {
    if (isTransientReadError(err)) {
      await sleep(300)
      return await getClassroomJson(client, { org, classroom })
    }
    throw err
  }
}

// Errors that don't prove the classroom's state: rate limiting, 5xx, and
// non-HTTP (network) failures. A 404 is determinate (handled by the caller as
// legacy/active) and is therefore NOT transient.
function isTransientReadError(err: unknown): boolean {
  if (err instanceof GitHubAPIError) {
    return err.isRateLimited || err.status >= 500
  }
  // A thrown non-GitHubAPIError here is a network/parse failure, not a
  // determinate API answer — treat as transient.
  return err instanceof Error
}

export async function editClassroomWithConflictRetry(
  client: GitHubClient,
  input: EditClassroomInput,
) {
  return withGitConflictRetry(() => editClassroom(client, input))
}

export type DeleteClassroomInput = {
  org: string
  classroom: string
  branch?: string
}

// Whether a failed team delete is worth retrying: a rate limit or 5xx is a
// transient blip; everything else is permanent and recorded without retrying.
function isTransientDeleteError(err: unknown): boolean {
  return (
    err instanceof GitHubAPIError && (err.isRateLimited || err.status >= 500)
  )
}

// Delete one classroom team, retrying a transient failure a few times with
// jittered backoff so a single hiccup doesn't strand a team. A permanent
// refusal throws immediately (the caller records it as a non-fatal warning).
async function deleteClassroomTeamWithRetry(
  client: GitHubClient,
  org: string,
  team: ClassroomTeamRef,
): Promise<void> {
  const attempts = 4
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await deleteClassroomTeam(client, org, team)
      return
    } catch (err) {
      lastError = err
      if (!isTransientDeleteError(err) || attempt === attempts) {
        throw err
      }
      log.debug("team delete transient failure, retrying", {
        org,
        teamSlug: team.slug,
        attempt,
      })
      await sleep(300 * attempt + Math.random() * 400)
    }
  }
  throw lastError
}

export async function deleteClassroom(
  client: GitHubClient,
  input: DeleteClassroomInput,
) {
  const { org, classroom, branch = "main" } = input
  const prefix = `${classroom}/`

  log.info("delete classroom: started", { org, classroom })

  // Resolve the team refs from classroom.json BEFORE the deletion commit
  // removes the file. No team block (pre-feature) or a read failure yields no
  // refs, making the deletes below no-ops. Both the students and staff teams are
  // removed so repo deletion doesn't orphan them.
  let team: { id: number; slug: string } | undefined
  let staffTeams: StaffTeamRefs
  try {
    const classroomJson = await getClassroomJson(client, {
      org,
      classroom,
      ref: branch,
    })
    team = classroomJson.team
    staffTeams = classroomJson.teams ?? {}
  } catch {
    log.debug(
      "delete classroom: classroom.json unreadable, no teams to remove",
      {
        org,
        classroom,
      },
    )
    team = undefined
    staffTeams = {}
  }

  const ref = await getBranchRef(client, org, branch)
  const commit = await getCommit(client, org, ref.object.sha)

  const currentTree = await client.request<{
    tree: Array<{
      path: string
      mode: string
      type: "blob" | "tree" | "commit"
      sha: string
    }>
    truncated: boolean
  }>(`/repos/${org}/classroom50/git/trees/${commit.tree.sha}?recursive=1`)

  if (currentTree.truncated) {
    throw new Error(
      "Tree is truncated; refusing to delete because not all classroom files were visible.",
    )
  }

  const entriesToDelete: GitTreeEntry[] = currentTree.tree
    .filter((entry) => entry.type === "blob")
    .filter(
      (entry) => entry.path === classroom || entry.path.startsWith(prefix),
    )
    .map((entry): GitTreeEntry => ({
      path: entry.path,
      mode: entry.mode as GitTreeFileMode,
      type: "blob",
      sha: null,
    }))

  if (entriesToDelete.length === 0) {
    return {
      deleted: false,
      reason: `No files found under ${prefix}`,
    }
  }

  const newTree = await client.request<{
    sha: string
  }>(`/repos/${org}/classroom50/git/trees`, {
    method: "POST",
    body: {
      base_tree: commit.tree.sha,
      tree: entriesToDelete,
    },
  })

  const newCommit = await client.request<{
    sha: string
  }>(`/repos/${org}/classroom50/git/commits`, {
    method: "POST",
    body: {
      message: prefixCommit(`Delete classroom ${classroom}`),
      tree: newTree.sha,
      parents: [commit.sha],
    },
  })

  await client.request(`/repos/${org}/classroom50/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: {
      sha: newCommit.sha,
      force: false,
    },
  })

  // Delete the per-classroom teams (idempotent; 404 = already gone): students
  // plus staff. Filtered through the shared guard so a drifted/hand-edited ref
  // outside the classroom50- namespace never enters the delete set. A delete
  // failure must NOT undo the already-committed config removal — surface it as a
  // non-fatal warning. Each delete retries a transient blip; a permanent refusal
  // is recorded without retrying.
  const refsToDelete = [team, staffTeams.instructor, staffTeams.ta].filter(
    isDeletableClassroomTeamRef,
  )
  const failedTeamSlugs: string[] = []
  for (const teamRef of refsToDelete) {
    try {
      await deleteClassroomTeamWithRetry(client, org, teamRef)
    } catch (err) {
      log.warn("delete classroom: team delete failed", {
        org,
        teamSlug: teamRef.slug,
        err,
        record: true,
      })
      failedTeamSlugs.push(teamRef.slug)
    }
  }
  const teamDeleteWarning =
    failedTeamSlugs.length > 0
      ? `Removed the classroom config but could not delete ${
          failedTeamSlugs.length === 1 ? "its team" : "its teams"
        } ${failedTeamSlugs
          .map((s) => `"${s}"`)
          .join(
            ", ",
          )}; delete by hand at https://github.com/orgs/${org}/teams if they linger.`
      : undefined

  log.info("delete classroom: completed", {
    org,
    classroom,
    deletedPaths: entriesToDelete.length,
    teamsFailed: failedTeamSlugs.length,
  })

  return {
    deleted: true,
    classroom,
    deletedPaths: entriesToDelete.map((entry) => entry.path),
    previousCommitSha: commit.sha,
    newTreeSha: newTree.sha,
    newCommitSha: newCommit.sha,
    teamDeleteWarning,
  }
}
