// Org-level GitHub Actions policy reads, shared by the read-only audit
// (orgChecks) and the write path (mutations/provisioning). Its own leaf module
// so both can import it without orgChecks -> mutations closing an import cycle
// (provisioning already imports orgChecks for repairOrgDefaults).

import type { GitHubClient } from "./client"
import { CONFIG_REPO } from "@/util/configRepo"

export type OrgActionsPermissions = {
  enabled_repositories: "all" | "none" | "selected"
  allowed_actions?: "all" | "local_only" | "selected"
  selected_actions_url?: string
}

type OrgSelectedRepositories = {
  total_count: number
  repositories: { id: number; name: string }[]
}

export async function getOrgActionsPermissions(
  client: GitHubClient,
  org: string,
): Promise<OrgActionsPermissions> {
  return client.request<OrgActionsPermissions>(
    `/orgs/${org}/actions/permissions`,
  )
}

async function listOrgActionsSelectedRepositories(
  client: GitHubClient,
  org: string,
  page: number,
): Promise<OrgSelectedRepositories> {
  return client.request<OrgSelectedRepositories>(
    `/orgs/${org}/actions/permissions/repositories?per_page=100&page=${page}`,
  )
}

// True when the config repo is currently in the org's "selected" Actions
// allow-list — the marker that distinguishes our intentional pause from an
// unrelated teacher-set "selected" policy that happens to exclude it. Paginates
// to exhaustion: a teacher's own allow-list can exceed 100 repos, and reading
// only page 1 could misclassify a policy we didn't author (and then wrongly
// widen it to "all" via the setup guard).
export async function orgActionsSelectionIncludesConfigRepo(
  client: GitHubClient,
  org: string,
): Promise<boolean> {
  let seen = 0
  for (let page = 1; ; page++) {
    const { total_count, repositories } =
      await listOrgActionsSelectedRepositories(client, org, page)
    if (repositories.some((r) => r.name === CONFIG_REPO)) return true
    seen += repositories.length
    if (repositories.length === 0 || seen >= total_count) return false
  }
}
