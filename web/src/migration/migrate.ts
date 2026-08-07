// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). The execute orchestrator: the
// irreversible migration. Composes the existing create-classroom primitives
// (team ensure/seed/drop, config-repo commit machinery) rather than forking
// them. Best-effort per item with a truthful result. Mirrors the CLI's
// performMigration.

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import {
  addRepositoryToTeam,
  addUserToTeam,
  createCommit,
  createTreeFromEntries,
  createBlob,
  ensureClassroomTeam,
  ensureStaffTeams,
  grantStaffTeamsConfigRepoAccess,
  removeUserFromTeam,
  updateRef,
} from "@/github-core/mutations"
import {
  createClassroomMetadata,
  STUDENTS_CSV_HEADER,
} from "@/github-core/mutations/gitObjects"
import { withGitConflictRetry } from "@/domain/classrooms"
import { CONFIG_REPO } from "@/util/configRepo"
import { prefixCommit } from "@/util/commit"
import type { Assignment } from "@/types/classroom"
import { logger } from "@/lib/logger"
import { classroomDirExists } from "./preflight"
import { copyOneTemplate } from "./templateCopy"
import { assignmentToEntry, classroomMigratedFrom } from "./translate"
import type {
  MigrationItemStatus,
  MigrationPreflight,
  MigrationResult,
} from "./types"

const log = logger.scope("migration:migrate")

export type MigrateOptions = {
  // The viewer's login, seeded as teacher and dropped from non-teacher teams.
  creator?: string
  // Streamed per-item progress for the UI.
  onItem?: (status: MigrationItemStatus) => void
}

// Execute a confirmed preflight plan. Best-effort: a per-item copy failure
// downgrades that item to skip and the scaffold still commits with the rest.
export async function migrateClassroom(
  client: GitHubClient,
  plan: MigrationPreflight,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  if (plan.blockers.length > 0) {
    throw new Error(
      "Cannot migrate: unresolved blockers (org setup or an existing classroom).",
    )
  }

  const { targetOrg, shortName } = plan
  const migratedAt = new Date()

  // Fail fast before any write if the dir appeared since preflight.
  if (await classroomDirExists(client, targetOrg, shortName)) {
    throw new Error(
      `Classroom "${shortName}" already exists in ${targetOrg}/${CONFIG_REPO} — refusing to overwrite.`,
    )
  }

  // --- Phase A: ensure teams FIRST (mirror createClassroomFiles) ---
  // Done before any template copy so a hard team-ensure failure aborts with
  // zero orphaned repos, rather than leaving generated-but-uncommitted repos
  // behind (best-effort copy can't undo a real GitHub write).
  const { ...team } = await ensureClassroomTeam(client, targetOrg, shortName)
  const { teams } = await ensureStaffTeams(client, targetOrg, shortName)

  if (options.creator && teams.teacher) {
    try {
      await addUserToTeam(client, {
        org: targetOrg,
        teamSlug: teams.teacher.slug,
        username: options.creator,
        role: "maintainer",
      })
    } catch {
      // Non-fatal; an owner can re-add via the roster UI.
    }
  }
  if (options.creator) {
    const dropSlugs = [team.slug, teams.hta?.slug, teams.ta?.slug].filter(
      (s): s is string => Boolean(s),
    )
    for (const teamSlug of dropSlugs) {
      try {
        await removeUserFromTeam(client, {
          org: targetOrg,
          teamSlug,
          username: options.creator,
        })
      } catch {
        // Non-fatal.
      }
    }
  }

  // Grant staff teams their config-repo access AFTER the drop (granting before
  // the owner removal emails them a "removed from team" alert — see
  // ensureStaffTeams). Same order as `classroom add`.
  try {
    await grantStaffTeamsConfigRepoAccess(client, targetOrg, teams)
  } catch (err) {
    log.warn("migrate: granting staff-team config-repo access failed", {
      targetOrg,
      shortName,
      err,
    })
  }

  // --- Phase B: copy templates (best-effort per item) ---
  const entries: Assignment[] = []
  const privateTemplates: Array<{ owner: string; repo: string }> = []
  const skipped: MigrationResult["skipped"] = []
  let generated = 0
  let reused = 0

  for (const item of plan.items) {
    if (item.action === "skip") {
      skipped.push({ slug: item.assignment.slug, reason: item.reason })
      options.onItem?.({
        slug: item.assignment.slug,
        targetName: item.targetName,
        status: "skipped",
        reason: item.reason,
      })
      continue
    }

    options.onItem?.({
      slug: item.assignment.slug,
      targetName: item.targetName,
      status: "running",
    })

    try {
      const copied = await copyOneTemplate(
        client,
        targetOrg,
        plan.classroom.id,
        item,
      )
      const entry = assignmentToEntry(
        item.assignment,
        plan.classroom.id,
        copied
          ? { owner: copied.owner, repo: copied.repo, branch: copied.branch }
          : null,
        migratedAt,
      )
      entries.push(entry)
      if (copied?.private)
        privateTemplates.push({ owner: copied.owner, repo: copied.repo })
      if (item.action === "import") generated++
      else reused++
      options.onItem?.({
        slug: item.assignment.slug,
        targetName: item.targetName,
        status: item.action === "import" ? "generated" : "reused",
      })
    } catch (err) {
      const reason = {
        key: "migration.reason.copyFailed",
        params: { message: err instanceof Error ? err.message : String(err) },
      }
      skipped.push({ slug: item.assignment.slug, reason })
      options.onItem?.({
        slug: item.assignment.slug,
        targetName: item.targetName,
        status: "skipped",
        reason,
      })
      log.warn("migration: template copy failed, skipping item", {
        slug: item.assignment.slug,
        err,
      })
    }
  }

  // --- Phase C: commit the four-file scaffold (with entries + migrated_from) ---
  const commitSha = await withGitConflictRetry(async () => {
    const branch = await getConfigRepoBranch(client, targetOrg)
    const ref = await getBranchRef(client, targetOrg, branch)
    const commit = await getCommit(client, targetOrg, ref.object.sha)

    // Re-assert the collision guard against the freshly-read tip each attempt:
    // the pre-write check above ran once, but a concurrent import of the same
    // short-name could have committed its scaffold since. Without this, a lost
    // fast-forward race would retry and clobber the winner's classroom.json
    // (last-writer-wins). Fail closed instead.
    if (await classroomDirExists(client, targetOrg, shortName)) {
      throw new Error(
        `Classroom "${shortName}" already exists in ${targetOrg}/${CONFIG_REPO} — refusing to overwrite.`,
      )
    }

    const classroomJson = {
      ...createClassroomMetadata(
        targetOrg,
        shortName,
        plan.name || plan.classroom.name,
        plan.term,
        { id: team.id, slug: team.slug },
        undefined,
        teams,
      ),
      migrated_from: classroomMigratedFrom(plan.classroom, migratedAt),
    }
    const assignmentsJson = {
      schema: "classroom50/assignments/v1",
      assignments: entries,
    }
    const scoresJson = { schema: "classroom50/scores/v1", assignments: {} }

    const files: Array<{ path: string; content: string }> = [
      {
        path: `${shortName}/classroom.json`,
        content: JSON.stringify(classroomJson, null, 2),
      },
      {
        path: `${shortName}/assignments.json`,
        content: JSON.stringify(assignmentsJson, null, 2),
      },
      { path: `${shortName}/roster.csv`, content: STUDENTS_CSV_HEADER },
      {
        path: `${shortName}/scores.json`,
        content: JSON.stringify(scoresJson, null, 2),
      },
    ]

    const blobs = await Promise.all(
      files.map((f) =>
        createBlob(client, { org: targetOrg, content: f.content }),
      ),
    )
    const tree = await createTreeFromEntries(client, {
      org: targetOrg,
      base_tree: commit.tree.sha,
      tree: files.map((f, i) => ({
        path: f.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobs[i].sha,
      })),
    })
    const newCommit = await createCommit(client, {
      org: targetOrg,
      classroom: shortName,
      parents: [ref.object.sha],
      tree_sha: tree.sha,
      message: prefixCommit(
        `Migrate ${shortName} from GitHub Classroom ${plan.classroom.id}`,
      ),
    })
    await updateRef(client, targetOrg, newCommit.sha, branch)
    return newCommit.sha
  })

  // --- Phase D: grant the classroom + staff teams read on private templates ---
  const staffSlugs = [teams.hta?.slug, teams.ta?.slug].filter(
    (s): s is string => Boolean(s),
  )
  for (const tpl of privateTemplates) {
    for (const teamSlug of [team.slug, ...staffSlugs]) {
      try {
        await addRepositoryToTeam(client, {
          org: targetOrg,
          teamSlug,
          owner: tpl.owner,
          repo: tpl.repo,
          permission: "pull",
        })
      } catch (err) {
        // Best-effort: a failed grant means students may 404 on accept until an
        // owner re-grants (via the assignment editor). Non-fatal to the commit.
        log.warn("migration: private-template grant failed", {
          teamSlug,
          repo: `${tpl.owner}/${tpl.repo}`,
          err: err instanceof GitHubAPIError ? err.status : err,
        })
      }
    }
  }

  log.info("migration: complete", {
    org: targetOrg,
    shortName,
    generated,
    reused,
    skipped: skipped.length,
  })

  return { shortName, commitSha, generated, reused, skipped }
}
