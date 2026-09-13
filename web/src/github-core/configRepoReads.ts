import type { GitHubClient } from "@/github-core/client"
import type {
  GitHubBranchRef,
  GitHubCommitRef,
  GitHubRepo,
} from "@/github-core/types"
import type { Classroom } from "@/types/classroom"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { classroomFilePath } from "@/util/configRepoPaths"
import { mapWithConcurrency } from "@/util/concurrency"
import { GitHubAPIError } from "./errors"
import { listClassroomDirs } from "./queries/orgReads"
import { REPO_READ_CONCURRENCY } from "./queries/shared"

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
  const path = classroomFilePath(input.classroom)
  const query = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ""

  const raw = await client.requestRaw(
    `/repos/${input.org}/${CONFIG_REPO}/contents/${path}${query}`,
  )

  try {
    return JSON.parse(raw)
  } catch (cause) {
    throw new ClassroomConfigError(input.classroom, cause)
  }
}

// classroom.json was fetched but could not be parsed. Distinct from a GitHub
// failure because no retry fixes it, so callers can name the file to repair
// instead of asking the teacher to try again.
export class ClassroomConfigError extends Error {
  readonly classroom: string
  constructor(classroom: string, cause: unknown) {
    super(`${classroom}/classroom.json is not valid JSON`, { cause })
    this.name = "ClassroomConfigError"
    this.classroom = classroom
  }
}

// Visit every classroom directory in the config repo that holds a readable
// classroom.json. A missing config repo (fresh org) is a clean no-op and a
// directory without classroom.json is not a classroom; any other failure,
// listing or per-classroom, goes to `onError` so the caller chooses between
// best-effort (log, continue) and fail-closed (rethrow). Shared by teardown
// and the ruleset bypass collector so both read classroom.json the same way.
export async function forEachClassroom(
  client: GitHubClient,
  org: string,
  onError: (classroom: string | null, err: unknown) => void,
  fn: (classroom: string, json: Classroom) => void,
  concurrency = REPO_READ_CONCURRENCY,
): Promise<void> {
  let dirs: { name: string }[]
  try {
    dirs = await listClassroomDirs(client, org)
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return
    onError(null, err)
    return
  }
  await mapWithConcurrency(dirs, concurrency, async (dir) => {
    let json: Classroom
    try {
      json = await getClassroomJson(client, { org, classroom: dir.name })
    } catch (err) {
      if (err instanceof GitHubAPIError && err.isNotFound) return
      onError(dir.name, err)
      return
    }
    fn(dir.name, json)
  })
}
