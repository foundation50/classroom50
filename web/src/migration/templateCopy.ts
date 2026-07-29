// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). The WRITE primitives that copy a
// source starter into a fresh target template: generate, mark-as-template, and
// wait for the new branch to stabilize. Mirrors the CLI's migrate_template.go.

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { withFreshRepoRetry } from "@/github-core/queries"
import { logger } from "@/lib/logger"
import type { LocalizedMessage } from "@/types/localizedMessage"
import type { MigrationItem } from "./types"

const log = logger.scope("migration:templateCopy")

// The resolved target template ref plus its visibility, for the entry write and
// the private-template grant decision.
export type CopiedTemplate = {
  owner: string
  repo: string
  branch: string
  private: boolean
}

// POST /repos/{srcOwner}/{srcRepo}/generate — create a new repo from the source
// template. `include_all_branches` and privacy inherited from the source mirror
// the CLI. Returns the new default branch.
async function generateFromTemplate(
  client: GitHubClient,
  args: {
    srcOwner: string
    srcRepo: string
    targetOwner: string
    targetName: string
    description: string
    private: boolean
  },
): Promise<string> {
  const repo = await client.request<{ default_branch: string }>(
    `/repos/${args.srcOwner}/${args.srcRepo}/generate`,
    {
      method: "POST",
      body: {
        owner: args.targetOwner,
        name: args.targetName,
        description: args.description,
        include_all_branches: true,
        private: args.private,
      },
    },
  )
  if (!repo.default_branch) {
    throw new Error(
      `generate ${args.targetOwner}/${args.targetName}: response missing default_branch`,
    )
  }
  return repo.default_branch
}

// PATCH /repos/{owner}/{repo} is_template:true — generate always produces a
// non-template repo, so flip it so `student accept` can generate from it.
async function markAsTemplate(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<void> {
  await client.request(`/repos/${owner}/${repo}`, {
    method: "PATCH",
    body: { is_template: true },
  })
}

// Wait for the freshly generated branch ref to propagate before a later
// `student accept` runs against it (avoids transient 409 "Git Repository is
// empty"). Best-effort; a lag timeout is non-fatal (the caller proceeds).
async function waitForBranch(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  try {
    await withFreshRepoRetry(() =>
      client.request(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      ),
    )
  } catch {
    // Non-fatal: the repo exists and is a template; the wait was a courtesy.
  }
}

// Perform the copy for one classified item. `reuse` returns the existing ref
// without writing; `import` generates + marks-as-template + waits. A
// template-less import returns null (nothing is copied). `skip` items must not
// reach here. Throws on a generate/mark failure so the caller can downgrade the
// item to skip (best-effort execute).
export async function copyOneTemplate(
  client: GitHubClient,
  targetOrg: string,
  classroomId: number,
  item: MigrationItem,
): Promise<CopiedTemplate | null> {
  if (item.action === "skip") {
    throw new Error(
      `copyOneTemplate called on a skipped item (${item.assignment.slug})`,
    )
  }

  // Template-less import: no starter repo to copy; the entry is written with no
  // template and students get an empty repo on accept.
  if (item.templateLess) {
    return null
  }

  if (item.action === "reuse") {
    return {
      owner: targetOrg,
      repo: item.targetName,
      branch: item.branch ?? "main",
      private: item.targetPrivate ?? false,
    }
  }

  const starter = item.assignment.starter_code_repository
  if (!starter?.full_name) {
    throw new Error(`Assignment "${item.assignment.slug}" has no starter repo.`)
  }
  const [srcOwner, srcRepo] = starter.full_name.split("/")

  log.info("migration: generating template", {
    slug: item.assignment.slug,
    source: starter.full_name,
    target: `${targetOrg}/${item.targetName}`,
    private: starter.private,
  })

  let branch: string
  try {
    branch = await generateFromTemplate(client, {
      srcOwner,
      srcRepo,
      targetOwner: targetOrg,
      targetName: item.targetName,
      description: `Migrated from GitHub Classroom (classroom ${classroomId}, assignment ${item.assignment.id})`,
      private: starter.private,
    })
  } catch (err) {
    // Surface the GitHub status + message so the skip reason is actionable.
    // A 403/404 generating from a template in a DIFFERENT org than the target
    // usually means the OAuth app isn't approved for the source org — call that
    // out specifically; otherwise relay the status + message.
    if (err instanceof GitHubAPIError) {
      log.warn("migration: generate failed", {
        source: starter.full_name,
        target: `${targetOrg}/${item.targetName}`,
        status: err.status,
        message: err.message,
      })
      const crossOrg = srcOwner.toLowerCase() !== targetOrg.toLowerCase()
      if ((err.isForbidden || err.isNotFound) && crossOrg) {
        throw new TemplateSourceAccessError(srcOwner, starter.full_name, err)
      }
      // TOCTOU: the target name was free when classify probed (404 -> import)
      // but has since been created (another import, a manual create, or a retry
      // of this one), so generate 422s on the name collision. Re-probe: if it's
      // now a usable template, reuse it instead of dropping the assignment;
      // otherwise raise a distinct, actionable collision error.
      if (err.status === 422) {
        const now = await client
          .request<{
            is_template: boolean
            default_branch: string
            private: boolean
          }>(`/repos/${targetOrg}/${item.targetName}`)
          .catch(() => null)
        if (now) {
          if (now.is_template) {
            return {
              owner: targetOrg,
              repo: item.targetName,
              branch: now.default_branch,
              private: now.private,
            }
          }
          throw new TargetRepoCollisionError(targetOrg, item.targetName, err)
        }
      }
      throw new Error(
        `${err.status} generating ${targetOrg}/${item.targetName} from ${starter.full_name}: ${err.message}`,
        { cause: err },
      )
    }
    throw err
  }

  await markAsTemplate(client, targetOrg, item.targetName)
  await waitForBranch(client, targetOrg, item.targetName, branch)

  return {
    owner: targetOrg,
    repo: item.targetName,
    branch,
    private: starter.private,
  }
}

// A generate that failed because the source template lives in a different org
// the OAuth app can't read (the common cross-org migration 403/404). The
// message names the source org and the fix so the skip line is actionable.
export class TemplateSourceAccessError extends Error {
  sourceOrg: string
  localized: LocalizedMessage
  constructor(sourceOrg: string, fullName: string, cause: GitHubAPIError) {
    super(
      `Can't read the starter repository "${fullName}" — approve the Classroom 50 app for the "${sourceOrg}" organization (Settings → Applications → Authorized OAuth Apps → Classroom 50 → Grant), then retry. (GitHub: ${cause.status} ${cause.message})`,
      { cause },
    )
    this.name = "TemplateSourceAccessError"
    this.sourceOrg = sourceOrg
    this.localized = {
      key: "migration.error.templateSourceAccess",
      params: {
        fullName,
        org: sourceOrg,
        detail: {
          key: "migration.error.githubSaid",
          params: { status: cause.status, message: cause.message },
        },
      },
    }
  }
}

// A generate that 422'd on the target name because a NON-template repo already
// occupies it (a TOCTOU collision since classify's 404 probe). Distinct from a
// generic copy failure so the skip line tells the teacher to rename via the
// template suffix rather than implying the source was unreadable.
export class TargetRepoCollisionError extends Error {
  targetName: string
  localized: LocalizedMessage
  constructor(targetOrg: string, targetName: string, cause: GitHubAPIError) {
    super(
      `A repository named "${targetOrg}/${targetName}" already exists and is not a template — choose a different template suffix and retry. (GitHub: ${cause.status} ${cause.message})`,
      { cause },
    )
    this.name = "TargetRepoCollisionError"
    this.targetName = targetName
    this.localized = {
      key: "migration.error.targetRepoCollision",
      params: {
        repo: `${targetOrg}/${targetName}`,
        detail: {
          key: "migration.error.githubSaid",
          params: { status: cause.status, message: cause.message },
        },
      },
    }
  }
}
