// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). The WRITE primitives that copy a
// source starter into a fresh target template: generate, mark-as-template, and
// wait for the new branch to stabilize. Mirrors the CLI's migrate_template.go.

import type { GitHubClient } from "@/github-core/client"
import { withFreshRepoRetry } from "@/github-core/queries"
import type { MigrationItem } from "./types"

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

  const branch = await generateFromTemplate(client, {
    srcOwner,
    srcRepo,
    targetOwner: targetOrg,
    targetName: item.targetName,
    description: `Migrated from GitHub Classroom (classroom ${classroomId}, assignment ${item.assignment.id})`,
    private: starter.private,
  })

  await markAsTemplate(client, targetOrg, item.targetName)
  await waitForBranch(client, targetOrg, item.targetName, branch)

  return {
    owner: targetOrg,
    repo: item.targetName,
    branch,
    private: starter.private,
  }
}
