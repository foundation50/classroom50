import type { GitHubClient } from "@/github-core/client"
import type {
  GitHubBranchRef,
  GitHubCommitRef,
  GitHubRepo,
} from "@/github-core/types"
import type { Classroom } from "@/types/classroom"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"

// Low-level config-repo read primitives, consumed downward by the domain
// operations in domain/ (framework-free engines above github-core).

// The classroom50 config repo's default branch. Org policy can seed a new repo
// on `master`, so config-repo reads/writes must target the real branch, not a
// hardcoded default. Falls back to DEFAULT_BRANCH only when the value is empty.
export async function getConfigRepoBranch(
  client: GitHubClient,
  org: string,
): Promise<string> {
  const repo = await client.request<GitHubRepo>(`/repos/${org}/${CONFIG_REPO}`)
  return repo.default_branch || DEFAULT_BRANCH
}

export function getBranchRef(
  client: GitHubClient,
  org: string,
  branch?: string,
) {
  return client.request<GitHubBranchRef>(
    `/repos/${org}/${CONFIG_REPO}/git/ref/heads/${encodeURIComponent(branch ?? DEFAULT_BRANCH)}`,
  )
}

export function getCommit(
  client: GitHubClient,
  org: string,
  branchSha: string,
) {
  return client.request<GitHubCommitRef>(
    `/repos/${org}/${CONFIG_REPO}/git/commits/${branchSha}`,
  )
}

export async function getClassroomJson(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    ref?: string
  },
): Promise<Classroom> {
  const path = `${input.classroom}/classroom.json`
  const query = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ""

  const raw = await client.requestRaw(
    `/repos/${input.org}/${CONFIG_REPO}/contents/${path}${query}`,
  )

  return JSON.parse(raw)
}
