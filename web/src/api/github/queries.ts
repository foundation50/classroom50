import type { GitHubClient } from "@/hooks/github/client"
import type {
  GitHubBranchRef,
  GitHubCommitRef,
  GitHubRepo,
} from "@/hooks/github/types"
import type { Classroom } from "@/types/classroom"

// The classroom50 config repo's default branch. Org policy can seed a new repo
// on `master`, so config-repo reads/writes must target the real branch, not a
// hardcoded `main`. Falls back to `main` only when the value is empty.
export async function getConfigRepoBranch(
  client: GitHubClient,
  org: string,
): Promise<string> {
  const repo = await client.request<GitHubRepo>(`/repos/${org}/classroom50`)
  return repo.default_branch || "main"
}

export function getBranchRef(
  client: GitHubClient,
  org: string,
  branch?: string,
) {
  return client.request<GitHubBranchRef>(
    `/repos/${org}/classroom50/git/ref/heads/${encodeURIComponent(branch ?? "main")}`,
  )
}

export function getCommit(
  client: GitHubClient,
  org: string,
  branchSha: string,
) {
  return client.request<GitHubCommitRef>(
    `/repos/${org}/classroom50/git/commits/${branchSha}`,
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
    `/repos/${input.org}/classroom50/contents/${path}${query}`,
  )

  return JSON.parse(raw)
}
