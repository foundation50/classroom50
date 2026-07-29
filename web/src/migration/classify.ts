// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Read-only per-assignment classifier
// shared by preflight (the confirm screen) and execute, so what the teacher
// approves is exactly what runs. Mirrors the branching of the CLI's
// copyOneTemplate, but issues only GETs. Reasons are translatable { key, params }.

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { SHORT_NAME_PATTERN } from "./translate"
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

function splitFullName(
  fullName: string,
): { owner: string; repo: string } | null {
  const parts = fullName.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], repo: parts[1] }
}

// Classify one source assignment, read-only. Returns import/reuse/skip with a
// translatable reason for reuse/skip and the resolved target name/branch.
export async function classifyAssignment(
  client: GitHubClient,
  targetOrg: string,
  templateSuffix: string,
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
  if (assignment.type !== "individual" && assignment.type !== "group") {
    return skip({
      key: "migration.reason.invalidMode",
      params: { type: assignment.type },
    })
  }

  const starter = assignment.starter_code_repository
  if (!starter || !starter.full_name) {
    return skip({ key: "migration.reason.noStarter" })
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
    if (err instanceof GitHubAPIError && err.isNotFound) {
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
