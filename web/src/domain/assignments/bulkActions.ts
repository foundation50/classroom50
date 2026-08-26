import type { GitHubClient } from "@/github-core/client"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import {
  createGitCommit,
  createGitTree,
  updateRef,
} from "@/github-core/mutations"
import { prefixCommit } from "@/util/commit"
import type { Assignment } from "@/types/classroom"

import { getAssignmentsFile } from "../queries/assignments"
import { mapWithConcurrency } from "@/util/concurrency"

import { getErrorMessage } from "@/github-core/errorMessage"

import { assertClassroomNotArchived, withGitConflictRetry } from "../classrooms"
import { copyAssignmentWithConflictRetry } from "./copyReuse"
import { log } from "./accessPrimitives"
import { reconcileLockTemplateAccess } from "./createEdit"

// Batched counterparts of setAssignmentLock and deleteAssignment, for the
// assignments page's bulk bar.
//
// The single-assignment functions each do a full read-modify-write of
// <classroom>/assignments.json — read the ref, read the file, build a tree,
// commit, move the ref. Looping them over a selection would be N commits to
// ONE file, strictly serialized on the ref each previous write just moved, and
// every one of them a conflict-retry candidate. These collapse the selection
// into a single tree and a single commit instead, so the classroom's history
// gets one entry for one user action and a partial write is impossible: the
// commit either lands for every selected assignment or for none.
//
// What deliberately does NOT batch: the lock's template reconciliation. Each
// private in-org template is its own grant/revoke call, and reconcile already
// degrades to a non-fatal warning rather than failing a committed flip — so it
// runs per assignment AFTER the commit, and the warnings come back per slug for
// the caller to surface.

// One assignment's outcome within a bulk run.
export type BulkAssignmentOutcome = {
  slug: string
  // Non-fatal: the flag was committed, but the template's student-team read
  // could not be reconciled. Never set for deletes.
  templateAccessWarning?: string
}

export type BulkLockResult = {
  // Slugs whose `locked` flag actually changed. A slug already in the requested
  // state is skipped (a stale tab, a double-click), mirroring the single-
  // assignment no-op. Empty means nothing was committed.
  changed: string[]
  // Selected slugs no longer present in assignments.json — deleted from another
  // tab or session between render and submit. Reported, never fatal.
  missing: string[]
  outcomes: BulkAssignmentOutcome[]
  newCommitSha: string | null
}

// Matches the fan-out limit the other multi-repo domain walks use.
const RECONCILE_CONCURRENCY = 4

// The read half of the config-repo write both functions below perform: the
// archived guard, the branch, the ref, the commit the tree will be based on,
// and the classroom's current assignments.json. Written once here rather than
// twice, so the two batched writes cannot drift in what they read.
type AssignmentsWriteContext = {
  configBranch: string
  headSha: string
  baseTreeSha: string
  path: string
  current: Awaited<ReturnType<typeof getAssignmentsFile>>
}

async function readAssignmentsForWrite(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<AssignmentsWriteContext> {
  const [, configBranch] = await Promise.all([
    assertClassroomNotArchived(client, org, classroom),
    getConfigRepoBranch(client, org),
  ])
  const ref = await getBranchRef(client, org, configBranch)
  const commit = await getCommit(client, org, ref.object.sha)
  const path = `${classroom}/assignments.json`
  const current = await getAssignmentsFile(client, {
    org,
    path,
    ref: ref.object.sha,
  })
  return {
    configBranch,
    headSha: ref.object.sha,
    baseTreeSha: commit.tree.sha,
    path,
    current,
  }
}

// The write half: one tree, one commit, one ref move. Returns the new commit's
// sha.
async function commitAssignments(
  client: GitHubClient,
  org: string,
  ctx: AssignmentsWriteContext,
  next: unknown,
  message: string,
): Promise<string> {
  const tree = await createGitTree(client, {
    org,
    base_tree: ctx.baseTreeSha,
    tree: [
      {
        path: ctx.path,
        mode: "100644",
        type: "blob",
        content: JSON.stringify(next, null, 2) + "\n",
      },
    ],
  })
  const newCommit = await createGitCommit(client, {
    org,
    message: prefixCommit(message),
    tree_sha: tree.sha,
    parents: [ctx.headSha],
  })
  await updateRef(client, org, newCommit.sha, ctx.configBranch)
  return newCommit.sha
}

// "1 assignment" / "3 assignments", for the commit subjects below.
const assignmentCount = (n: number) => `${n} assignment${n === 1 ? "" : "s"}`

export type SetAssignmentsLockInput = {
  org: string
  classroom: string
  slugs: string[]
  locked: boolean
}

export async function setAssignmentsLock(
  client: GitHubClient,
  input: SetAssignmentsLockInput,
): Promise<BulkLockResult> {
  const { org, classroom, slugs, locked } = input
  log.info("bulk set assignment lock: started", {
    org,
    classroom,
    count: slugs.length,
    locked,
  })

  const ctx = await readAssignmentsForWrite(client, org, classroom)
  const bySlug = new Map(
    ctx.current.assignments.map((a) => [a.slug, a] as const),
  )
  const missing = slugs.filter((slug) => !bySlug.has(slug))
  const present = slugs.filter((slug) => bySlug.has(slug))
  const changed = present.filter(
    (slug) => Boolean(bySlug.get(slug)?.locked) !== locked,
  )

  let newCommitSha: string | null = null

  if (changed.length > 0) {
    const changing = new Set(changed)
    const nextAssignments = {
      ...ctx.current,
      assignments: ctx.current.assignments.map((a) => {
        if (!changing.has(a.slug)) return a
        const updated: Assignment = { ...a, locked }
        // Collapse to the wire's absent-is-false shape (matches the CLI's
        // omitempty), so unlocking drops the key rather than writing
        // `locked: false`.
        if (!locked) delete updated.locked
        return updated
      }),
    }

    newCommitSha = await commitAssignments(
      client,
      org,
      ctx,
      nextAssignments,
      `${locked ? "Lock" : "Unlock"} ${assignmentCount(
        changed.length,
      )}: ${classroom}`,
    )
  }

  // Reconcile every SELECTED assignment that exists, not only the ones whose
  // flag moved: a previous run may have committed the flag and then failed the
  // grant/revoke, which is exactly the state the single-assignment path
  // re-reconciles on a repeat click.
  //
  // Run them with bounded concurrency rather than one after another: each is a
  // repo probe plus a team grant/revoke against a DIFFERENT template repo, it
  // never touches the config repo's ref, and both team calls are idempotent —
  // so nothing here serializes on shared state the way the commit above does.
  // Serially, unlocking twenty private-template assignments is up to a hundred
  // round trips in a chain. mapWithConcurrency preserves input order, so
  // `outcomes` still lines up with the selection.
  const outcomes = await mapWithConcurrency(
    present,
    RECONCILE_CONCURRENCY,
    async (slug) => ({
      slug,
      templateAccessWarning: await reconcileLockTemplateAccess(
        client,
        org,
        classroom,
        slug,
        bySlug.get(slug)?.template,
        locked,
      ),
    }),
  )

  return { changed, missing, outcomes, newCommitSha }
}

export function setAssignmentsLockWithConflictRetry(
  client: GitHubClient,
  input: SetAssignmentsLockInput,
) {
  return withGitConflictRetry(() => setAssignmentsLock(client, input))
}

export type BulkDeleteResult = {
  deleted: string[]
  // Selected slugs already absent from assignments.json — nothing to remove,
  // reported so the caller doesn't claim a delete that never happened.
  missing: string[]
  newCommitSha: string | null
}

export type DeleteAssignmentsInput = {
  org: string
  classroom: string
  slugs: string[]
}

export async function deleteAssignments(
  client: GitHubClient,
  input: DeleteAssignmentsInput,
): Promise<BulkDeleteResult> {
  const { org, classroom, slugs } = input
  log.info("bulk delete assignments: started", {
    org,
    classroom,
    count: slugs.length,
  })

  const ctx = await readAssignmentsForWrite(client, org, classroom)
  const existing = new Set(ctx.current.assignments.map((a) => a.slug))
  const deleted = slugs.filter((slug) => existing.has(slug))
  const missing = slugs.filter((slug) => !existing.has(slug))

  if (deleted.length === 0) {
    return { deleted, missing, newCommitSha: null }
  }

  const removing = new Set(deleted)
  const nextAssignments = {
    ...ctx.current,
    assignments: ctx.current.assignments.filter((a) => !removing.has(a.slug)),
  }

  const newCommitSha = await commitAssignments(
    client,
    org,
    ctx,
    nextAssignments,
    `Delete ${assignmentCount(deleted.length)}: ${classroom}`,
  )

  return { deleted, missing, newCommitSha }
}

export function deleteAssignmentsWithConflictRetry(
  client: GitHubClient,
  input: DeleteAssignmentsInput,
) {
  return withGitConflictRetry(() => deleteAssignments(client, input))
}

// One planned copy in a bulk reuse run. The target slugs are resolved and
// validated in the view (util/bulkReuseSlugs) so the teacher confirms every one
// before the run starts; this executes what was confirmed.
export type BulkCopyItem = { source: Assignment; targetSlug: string }

// One source assignment's fate in that run.
export type BulkCopyOutcome = {
  slug: string
  targetSlug?: string
  error?: string
}

export type BulkCopyAssignmentsInput = {
  org: string
  targetClassroom: string
  items: BulkCopyItem[]
  canGrantTemplateAccess: boolean
  // Called after every item, with the outcomes so far — the caller renders
  // progress from it. Sequential by necessity (see below), so a bulk run of
  // twelve is long enough that a silent wait would read as a hang.
  onProgress?: (outcomes: BulkCopyOutcome[]) => void
}

// Copy a selection of assignments into another classroom, one after another.
//
// The one bulk action here that does NOT batch: every copy is a read-modify-
// write of the TARGET classroom's assignments.json on the same git ref, and may
// create a repo besides — so two at once would collide on the ref that the
// other just moved. Hence a per-assignment outcome rather than a single
// verdict: with twelve sequential writes, "done" would hide which ones landed.
//
// One failed copy never abandons the rest. The remaining sources are
// independent writes, and stopping here would leave the teacher unable to tell
// which ones were even attempted.
export async function bulkCopyAssignments(
  client: GitHubClient,
  input: BulkCopyAssignmentsInput,
): Promise<BulkCopyOutcome[]> {
  const { org, targetClassroom, items, canGrantTemplateAccess, onProgress } =
    input
  log.info("bulk copy assignments: started", {
    org,
    targetClassroom,
    count: items.length,
  })

  const outcomes: BulkCopyOutcome[] = []
  for (const { source, targetSlug } of items) {
    try {
      await copyAssignmentWithConflictRetry(client, {
        org,
        source,
        targetClassroom,
        targetSlug,
        canGrantTemplateAccess,
      })
      outcomes.push({ slug: source.slug, targetSlug })
    } catch (err) {
      outcomes.push({ slug: source.slug, error: getErrorMessage(err) })
    }
    onProgress?.([...outcomes])
  }
  return outcomes
}
