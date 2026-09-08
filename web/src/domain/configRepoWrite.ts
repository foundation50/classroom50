import type { GitHubClient } from "@/github-core/client"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import {
  createGitCommit,
  createGitTree,
  updateRef,
  type GitTreeEntry,
} from "@/github-core/mutations"
import type { GitHubMoveBranch } from "@/github-core/types"
import { prefixCommit } from "@/util/commit"

import { assertClassroomNotArchived } from "./classrooms"

// The head of the config repo's default branch, read once per write attempt.
// Every field a writer needs to build a tree on top of it and move the ref.
export type ConfigRepoHead = {
  configBranch: string
  headSha: string
  baseTreeSha: string
}

// The archive guard is independent of the ref read, so they run concurrently;
// Promise.all rejects on the first rejection, so an archived classroom still
// fails closed before any write.
export async function readConfigRepoHead(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<ConfigRepoHead> {
  const [, configBranch] = await Promise.all([
    assertClassroomNotArchived(client, org, classroom),
    getConfigRepoBranch(client, org),
  ])
  return readConfigRepoHeadAt(client, org, configBranch)
}

// Same read without the archive guard, for writers that already resolved the
// branch (or must write to an archived classroom, such as a rename resume).
export async function readConfigRepoHeadAt(
  client: GitHubClient,
  org: string,
  configBranch: string,
): Promise<ConfigRepoHead> {
  const ref = await getBranchRef(client, org, configBranch)
  const commit = await getCommit(client, org, ref.object.sha)
  return { configBranch, headSha: ref.object.sha, baseTreeSha: commit.tree.sha }
}

export type ConfigRepoCommitResult = {
  newTreeSha: string
  newCommitSha: string
  updatedRef: GitHubMoveBranch
}

// The write half every config-repo mutation shares: one tree on the head's
// base tree, one commit with the head as parent, one ref move. The message is
// prefixed here so no writer can forget it. A concurrent write to the same
// branch surfaces as a non-fast-forward 409 from updateRef; callers wrap the
// read + commit in withGitConflictRetry to re-read and try again.
export async function commitConfigRepoFiles(
  client: GitHubClient,
  org: string,
  head: ConfigRepoHead,
  tree: GitTreeEntry[],
  message: string,
): Promise<ConfigRepoCommitResult> {
  const newTree = await createGitTree(client, {
    org,
    base_tree: head.baseTreeSha,
    tree,
  })
  const newCommit = await createGitCommit(client, {
    org,
    message: prefixCommit(message),
    tree_sha: newTree.sha,
    parents: [head.headSha],
  })
  const updatedRef = await updateRef(
    client,
    org,
    newCommit.sha,
    head.configBranch,
  )
  return { newTreeSha: newTree.sha, newCommitSha: newCommit.sha, updatedRef }
}

// The one JSON serialization every config-repo file uses (2-space, trailing
// newline), so a hand-edit and a web write produce identical bytes.
export function jsonFileEntry(path: string, value: unknown): GitTreeEntry {
  return {
    path,
    mode: "100644",
    type: "blob",
    content: JSON.stringify(value, null, 2) + "\n",
  }
}
