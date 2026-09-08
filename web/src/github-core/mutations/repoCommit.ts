import type { GitHubClient } from "../client"
import { getBranchRefRepo, getCommitByRepo } from "../queries/repoRefReads"
import type { GitHubCommitRef } from "../types"
import {
  createRepoCommit,
  createRepoTree,
  updateRepoRef,
  type GitTreeEntry,
} from "./gitObjects"

export type RepoRef = { owner: string; repo: string }

// A branch tip read once per write attempt: the SHA the commit parents on and
// the tree it builds on, plus the commit itself for callers that inspect it
// (accept checks whether it is the auto_init seed).
export type RepoHead = {
  branch: string
  headSha: string
  baseTreeSha: string
  commit: GitHubCommitRef
}

// A branch may exist before its commit is readable (a fresh template copy) or
// the commit may come back without a tree; `notReady` names that as the
// caller's own error instead of a bare undefined downstream.
export async function readRepoHead(
  client: GitHubClient,
  { owner, repo }: RepoRef,
  branch: string,
  notReady: () => Error = () =>
    new Error(`${owner}/${repo}: could not resolve the branch tip`),
): Promise<RepoHead> {
  const ref = await getBranchRefRepo(client, owner, repo, branch)
  const headSha = ref.object.sha
  const commit = await getCommitByRepo(client, owner, repo, headSha)
  const baseTreeSha = commit.tree?.sha
  if (!headSha || !baseTreeSha) throw notReady()
  return { branch, headSha, baseTreeSha, commit }
}

// Commit an already-built tree on the head and fast-forward the branch to it.
// Passing `head.baseTreeSha` makes an empty commit. The message is used
// verbatim: callers own their subject and any `[skip ci]` trailer.
export async function commitRepoTree(
  client: GitHubClient,
  { owner, repo }: RepoRef,
  head: RepoHead,
  treeSha: string,
  message: string,
): Promise<{ commitSha: string }> {
  const commit = await createRepoCommit(client, {
    owner,
    repo,
    message,
    treeSha,
    parentSha: head.headSha,
  })
  await updateRepoRef(client, {
    owner,
    repo,
    branch: head.branch,
    commitSha: commit.sha,
  })
  return { commitSha: commit.sha }
}

// The write half every student-repo file change shares: one tree on the
// head, then commitRepoTree.
export async function commitRepoFiles(
  client: GitHubClient,
  ref: RepoRef,
  head: RepoHead,
  tree: GitTreeEntry[],
  message: string,
): Promise<{ treeSha: string; commitSha: string }> {
  const { sha: treeSha } = await createRepoTree(client, {
    ...ref,
    baseTreeSha: head.baseTreeSha,
    tree,
  })
  const { commitSha } = await commitRepoTree(
    client,
    ref,
    head,
    treeSha,
    message,
  )
  return { treeSha, commitSha }
}
