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
import { getErrorMessage } from "@/github-core/errorMessage"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { getRepo } from "@/github-core/repoReads"
import { mapWithConcurrency } from "@/util/concurrency"

import {
  getAssignmentsFile,
  type AssignmentsFile,
} from "../queries/assignments"
import { assertClassroomNotArchived, withGitConflictRetry } from "../classrooms"
import { log } from "./accessPrimitives"
import {
  assertSlugFreeInTarget,
  buildReusedEntry,
  reuseTemplateNeedsGrant,
} from "./copyReuse"
import { reconcileLockTemplateAccess, resolveTemplateGrant } from "./createEdit"

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

// The read half of the config-repo write, shared so the batched writers
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
  // run may have committed the flag and then failed the grant/revoke. Once per
  // distinct template: the grant is a team permission on the template repo, so
  // twelve assignments on one template are one write, not twelve. A revoke is
  // skipped while an unselected, still-unlocked assignment uses the same
  // template: its students still need the read. Safe to run concurrently,
  // since each targets a different repo and never touches the config repo's ref.
  const stillOpen = new Set(
    ctx.current.assignments
      .filter((a) => a.template && !a.locked && !present.includes(a.slug))
      .map((a) => templateKey(a.template!)),
  )
  const reconciling = present.filter((slug) => {
    const template = bySlug.get(slug)?.template
    return !(locked && template && stillOpen.has(templateKey(template)))
  })
  const warnings = await reconcilePerTemplate(
    reconciling.map((slug) => ({ slug, template: bySlug.get(slug)?.template })),
    (slug, template) =>
      reconcileLockTemplateAccess(
        client,
        org,
        classroom,
        slug,
        template,
        locked,
      ),
  )
  const outcomes = present.map((slug) => ({
    slug,
    templateAccessWarning: warnings.get(slug),
  }))

  return { changed, missing, outcomes, newCommitSha }
}

const templateKey = (template: NonNullable<Assignment["template"]>) =>
  `${template.owner}/${template.repo}`.toLowerCase()

// Run one template-access write per distinct template and hand its warning to
// every slug sharing that template. The warning text names the first slug; the
// team and repo it points at are the same for all of them.
async function reconcilePerTemplate(
  items: { slug: string; template: Assignment["template"] }[],
  reconcile: (
    slug: string,
    template: Assignment["template"],
  ) => Promise<string | undefined>,
): Promise<Map<string, string | undefined>> {
  const groups = new Map<string, string[]>()
  for (const { slug, template } of items) {
    const key = template ? templateKey(template) : `slug:${slug}`
    groups.set(key, [...(groups.get(key) ?? []), slug])
  }
  const byTemplate = new Map(items.map((i) => [i.slug, i.template]))
  const results = await mapWithConcurrency(
    [...groups.values()],
    RECONCILE_CONCURRENCY,
    async (slugs) =>
      [slugs, await reconcile(slugs[0], byTemplate.get(slugs[0]))] as const,
  )
  const warnings = new Map<string, string | undefined>()
  for (const [slugs, warning] of results) {
    for (const slug of slugs) warnings.set(slug, warning)
  }
  return warnings
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
  // The copy was left out of the commit: its template is unusable from the
  // target, or its slug was taken by the time the file was read.
  error?: string
  // Non-fatal: the copy landed, but students can't accept it until the target
  // team is granted read on the private template.
  templateAccessWarning?: string
}

export type BulkCopyResult = {
  outcomes: BulkCopyOutcome[]
  newCommitSha: string | null
}

export type CopyAssignmentsInput = {
  org: string
  targetClassroom: string
  items: BulkCopyItem[]
  canGrantTemplateAccess: boolean
}

// Batched counterpart of copyAssignmentToClassroom: every valid copy lands in
// one commit to the target's assignments.json. A copy that fails its own
// checks (template, slug) is reported and left out; it never blocks the
// others. Grants follow the commit, once per template, like the lock's
// reconcile.
export async function copyAssignments(
  client: GitHubClient,
  input: CopyAssignmentsInput,
): Promise<BulkCopyResult> {
  const { org, targetClassroom, items, canGrantTemplateAccess } = input
  log.info("bulk copy assignments: started", {
    org,
    targetClassroom,
    count: items.length,
  })

  const ctx = await readAssignmentsForWrite(client, org, targetClassroom)

  // Same live template re-check as the single copy, one probe per distinct
  // template. A probe that fails (5xx, rate limit) fails only the copies on
  // that template, not the batch.
  const templates = new Map<string, NonNullable<Assignment["template"]>>()
  for (const { source } of items) {
    if (source.template)
      templates.set(templateKey(source.template), source.template)
  }
  type Probe =
    { repo: Awaited<ReturnType<typeof getRepo>> } | { error: unknown }
  const probes = new Map(
    await mapWithConcurrency(
      [...templates],
      REPO_READ_CONCURRENCY,
      async ([key, template]): Promise<readonly [string, Probe]> => {
        try {
          return [
            key,
            { repo: await getRepo(client, template.owner, template.repo) },
          ]
        } catch (error) {
          return [key, { error }]
        }
      },
    ),
  )

  const outcomes: BulkCopyOutcome[] = []
  const entries: { entry: Assignment; needsGrant: boolean }[] = []
  // Grows as entries are accepted, so two copies can't claim one slug even if
  // the planner was bypassed.
  const claimed: AssignmentsFile = {
    ...ctx.current,
    assignments: [...ctx.current.assignments],
  }
  for (const { source, targetSlug } of items) {
    try {
      const entry = buildReusedEntry(source, {
        slug: targetSlug,
        name: source.name,
      })
      const probe = entry.template
        ? probes.get(templateKey(entry.template))
        : undefined
      if (probe && "error" in probe) throw probe.error
      const needsGrant = reuseTemplateNeedsGrant(
        org,
        targetClassroom,
        entry,
        probe?.repo ?? null,
      )
      assertSlugFreeInTarget(entry.slug, claimed, targetClassroom)
      claimed.assignments.push(entry)
      entries.push({ entry, needsGrant })
      outcomes.push({ slug: source.slug, targetSlug: entry.slug })
    } catch (err) {
      outcomes.push({ slug: source.slug, error: getErrorMessage(err) })
    }
  }

  if (entries.length === 0) return { outcomes, newCommitSha: null }

  const newCommitSha = await commitAssignments(
    client,
    org,
    ctx,
    claimed,
    `Reuse ${assignmentCount(entries.length)} into ${targetClassroom}`,
  )

  // A locked source copies as locked, so withhold the grant like create and
  // the CLI's reuse do; unlocking the copy grants it. One grant per template.
  const granting = entries.filter(
    ({ entry, needsGrant }) => needsGrant && entry.template && !entry.locked,
  )
  const warnings = await reconcilePerTemplate(
    granting.map(({ entry }) => ({
      slug: entry.slug,
      template: entry.template,
    })),
    (slug, template) =>
      template
        ? resolveTemplateGrant(
            client,
            org,
            targetClassroom,
            slug,
            template,
            canGrantTemplateAccess,
          )
        : Promise.resolve(undefined),
  )
  for (const outcome of outcomes) {
    const warning = outcome.targetSlug && warnings.get(outcome.targetSlug)
    if (warning) outcome.templateAccessWarning = warning
  }

  return { outcomes, newCommitSha }
}

export function copyAssignmentsWithConflictRetry(
  client: GitHubClient,
  input: CopyAssignmentsInput,
) {
  return withGitConflictRetry(() => copyAssignments(client, input))
}
