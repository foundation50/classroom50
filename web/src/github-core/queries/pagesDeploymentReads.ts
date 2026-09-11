import type { GitHubClient } from "../client"
import { GitHubAPIError } from "../errors"
import { CONFIG_REPO } from "@/util/configRepo"

// GET /repos/{owner}/{repo}/pages/deployments/{id}. The id can be the commit
// SHA, which is how GitHub names a blocking deployment in its 400 refusal.
// https://docs.github.com/en/rest/pages/pages#get-the-status-of-a-github-pages-deployment
export type PagesDeploymentStatus =
  | "deployment_in_progress"
  | "syncing_files"
  | "finished_file_sync"
  | "updating_pages"
  | "purging_cdn"
  | "deployment_cancelled"
  | "deployment_failed"
  | "deployment_content_failed"
  | "deployment_attempt_error"
  | "deployment_lost"
  | "succeed"

const IN_PROGRESS_STATUSES: ReadonlySet<PagesDeploymentStatus> =
  new Set<PagesDeploymentStatus>([
    "deployment_in_progress",
    "syncing_files",
    "finished_file_sync",
    "updating_pages",
    "purging_cdn",
    // GitHub schedules a retry, so the lock is still held.
    "deployment_attempt_error",
  ])

export function isPagesDeploymentInProgress(
  status: PagesDeploymentStatus,
): boolean {
  return IN_PROGRESS_STATUSES.has(status)
}

// `null` when GitHub no longer has the deployment (404): the lock is gone
// either way.
export async function getPagesDeploymentStatus(
  client: GitHubClient,
  org: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<PagesDeploymentStatus | null> {
  try {
    const res = await client.request<{ status?: PagesDeploymentStatus }>(
      `/repos/${encodeURIComponent(org)}/${CONFIG_REPO}/pages/deployments/${encodeURIComponent(deploymentId)}`,
      { method: "GET", signal },
    )
    return res.status ?? null
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return null
    throw err
  }
}
