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

// Batched counterparts of setAssignmentLock and deleteAssignment. Looping the
// single-assignment writers over a selection would be N commits to one file,
// each serialized on the ref the previous one just moved and each a
// conflict-retry candidate; one tree and one commit make a partial write
// impossible. The lock's template reconciliation stays per assignment: each
// template is its own grant/revoke, and it already degrades to a warning.

export type BulkAssignmentOutcome = {
  slug: string
  // Non-fatal: the flag was committed but the template read could not be
  // reconciled. Never set for deletes.
  templateAccessWarning?: string
}

export type BulkLockResult = {
  // Slugs whose flag actually changed; one already in the requested state is
  // skipped, like the single-assignment no-op. Empty means nothing committed.
  changed: string[]
  // Selected slugs no longer in assignments.json (deleted elsewhere between
  // render and submit). Reported, never fatal.
  missing: string[]
  outcomes: BulkAssignmentOutcome[]
  newCommitSha: string | null
}

// Below REPO_READ_CONCURRENCY (8): each reconcile is a team permission write,
// and GitHub's secondary rate limits bite on concurrent writes.
const RECONCILE_CONCURRENCY = 4

// The read half of the config-repo write, shared so the two batched writers
// cannot drift in what they read.
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

// The write half: one tree, one commit, one ref move.
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
        // Match the CLI's omitempty: unlocking drops the key.
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

  // Reconcile every present assignment, not only the changed ones: a previous
  // run may have committed the flag and then failed the grant/revoke. Safe to
  // run concurrently, since each targets a different template repo and never
  // touches the config repo's ref.
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
  // Selected slugs already absent from assignments.json.
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

// A copy the teacher already confirmed; slugs are resolved and validated in
// util/bulkReuseSlugs before the run starts.
export type BulkCopyItem = { source: Assignment; targetSlug: string }

export type BulkCopyOutcome = {
  slug: string
  targetSlug?: string
  error?: string
  // Non-fatal: the copy landed, but students can't accept it until the target
  // team is granted read on the private template.
  templateAccessWarning?: string
}

export type BulkCopyAssignmentsInput = {
  org: string
  targetClassroom: string
  items: BulkCopyItem[]
  canGrantTemplateAccess: boolean
  // Called after every item with the outcomes so far.
  onProgress?: (outcomes: BulkCopyOutcome[]) => void
}

// Sequential, unlike lock and delete: every copy is a read-modify-write of the
// target's assignments.json on the same ref and may create a repo. One failed
// copy doesn't abandon the rest; each source gets its own outcome.
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
      const result = await copyAssignmentWithConflictRetry(client, {
        org,
        source,
        targetClassroom,
        targetSlug,
        canGrantTemplateAccess,
      })
      outcomes.push({
        slug: source.slug,
        targetSlug,
        ...(result.templateGrantWarning
          ? { templateAccessWarning: result.templateGrantWarning }
          : {}),
      })
    } catch (err) {
      outcomes.push({ slug: source.slug, error: getErrorMessage(err) })
    }
    onProgress?.([...outcomes])
  }
  return outcomes
}
