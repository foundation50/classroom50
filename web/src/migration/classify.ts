// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Read-only per-assignment classifier
// shared by preflight (the confirm screen) and execute, so what the teacher
// approves is exactly what runs. Mirrors the branching of the CLI's
// copyOneTemplate, but issues only GETs. Reasons are translatable { key, params }.

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { SHORT_NAME_PATTERN } from "@/util/shortName"
import {
  GITHUB_REPO_NAME_MAX_LEN,
  assignmentSlugBudget,
  composedRepoNameFits,
} from "@/util/repoNameBudget"
import { splitFullName } from "@/util/repoFullName"
import type {
  ClassroomAssignmentDetail,
  MigrationItem,
  MigrationReason,
} from "./types"

// The target repo name: slug, optionally with a collision-avoiding suffix.
export function targetTemplateName(slug: string, suffix: string): string {
  return suffix ? `${slug}-${suffix}` : slug
}

// GET /repos/{owner}/{repo} projection for a target-repo probe.
type RepoProbe = {
  exists: boolean
  isTemplate: boolean
  branch: string
  private: boolean
}

async function probeTargetRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoProbe> {
  try {
    const r = await client.request<{
      is_template: boolean
      default_branch: string
      private: boolean
    }>(`/repos/${owner}/${repo}`)
    return {
      exists: true,
      isTemplate: r.is_template,
      branch: r.default_branch,
      private: r.private,
    }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      return { exists: false, isTemplate: false, branch: "", private: false }
    }
    throw err
  }
}

// GET /repos/{owner}/{repo}.is_template — the source must be a template for
// GitHub's generate endpoint to accept it. A 404 means we can't read it.
async function sourceIsTemplate(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<boolean> {
  const r = await client.request<{ is_template: boolean }>(
    `/repos/${owner}/${repo}`,
  )
  return r.is_template
}

// Classify one source assignment, read-only. Returns import/reuse/skip with a
// translatable reason for reuse/skip and the resolved target name/branch.
// `shortName` is the TARGET classroom directory, for the composed repo-name
// budget check.
export async function classifyAssignment(
  client: GitHubClient,
  targetOrg: string,
  templateSuffix: string,
  shortName: string,
  assignment: ClassroomAssignmentDetail,
): Promise<MigrationItem> {
  const targetName = targetTemplateName(assignment.slug, templateSuffix)
  const skip = (reason: MigrationReason): MigrationItem => ({
    assignment,
    action: "skip",
    reason,
    targetName,
  })

  // Validate the shape a downstream entry needs BEFORE any network call.
  if (!SHORT_NAME_PATTERN.test(assignment.slug)) {
    return skip({
      key: "migration.reason.invalidSlug",
      params: { slug: assignment.slug },
    })
  }
  // #691: a slug that composes past GitHub's repo-name limit with the target
  // short-name would fail every long-username accept — skip it (the rest of
  // the migration proceeds). Mirrors the CLI's copyOneTemplate guard.
  if (!composedRepoNameFits(shortName, assignment.slug).fits) {
    return skip({
      key: "migration.reason.slugOverBudget",
      params: {
        slug: assignment.slug,
        budget: String(assignmentSlugBudget(shortName)),
        limit: String(GITHUB_REPO_NAME_MAX_LEN),
      },
    })
  }
  if (assignment.type !== "individual" && assignment.type !== "group") {
    return skip({
      key: "migration.reason.invalidMode",
      params: { type: assignment.type },
    })
  }

  const starter = assignment.starter_code_repository
  if (!starter || !starter.full_name) {
    // No starter repo -> import as a TEMPLATE-LESS assignment. Classroom 50
    // supports these: on accept, students get an empty repo with just the
    // autograde shim. No template copy happens.
    return {
      assignment,
      action: "import",
      targetName,
      templateLess: true,
    }
  }
  const src = splitFullName(starter.full_name)
  if (!src) {
    return skip({
      key: "migration.reason.badStarter",
      params: { fullName: starter.full_name },
    })
  }

  let srcIsTemplate: boolean
  try {
    srcIsTemplate = await sourceIsTemplate(client, src.owner, src.repo)
  } catch (err) {
    if (err instanceof GitHubAPIError && (err.isForbidden || err.isNotFound)) {
      // Can't read the starter. When the source repo lives in a DIFFERENT org
      // than the target, this is almost always the OAuth app not being approved
      // for the source org — a fixable authorization gap, surfaced as a
      // preflight blocker (not a per-item skip) by buildPreflight. Carry the
      // source org so the blocker can link the grant page.
      const crossOrg = src.owner.toLowerCase() !== targetOrg.toLowerCase()
      if (crossOrg) {
        return skip({
          key: "migration.reason.sourceOrgAccess",
          params: { org: src.owner },
        })
      }
      return skip({
        key: "migration.reason.sourceNotAccessible",
        params: { fullName: starter.full_name },
      })
    }
    throw err
  }
  if (!srcIsTemplate) {
    return skip({
      key: "migration.reason.sourceNotTemplate",
      params: { fullName: starter.full_name },
    })
  }

  const probe = await probeTargetRepo(client, targetOrg, targetName)
  if (probe.exists) {
    if (!probe.isTemplate) {
      return skip({
        key: "migration.reason.targetCollision",
        params: { org: targetOrg, name: targetName },
      })
    }
    return {
      assignment,
      action: "reuse",
      targetName,
      branch: probe.branch,
      targetPrivate: probe.private,
    }
  }

  // 404 on the target: safe to generate. Target privacy will inherit the
  // source's on generate (recorded here for the grant decision).
  return {
    assignment,
    action: "import",
    targetName,
    targetPrivate: starter.private,
  }
}
