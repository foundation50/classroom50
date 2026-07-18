import type { GitHubClient } from "@/github-core/client"
import {
  createBlobForRepo,
  createCommitForAssignment,
  createTreeFromFullEntries,
  getRepoTreeRecursive,
  updateRefForRepo,
  type GitHubTreeEntryFull,
} from "@/github-core/mutations"
import { getRepo } from "@/github-core/repoReads"
import {
  getBranchRefRepo,
  getCommitByRepo,
  withFreshRepoRetry,
} from "@/github-core/queries"
import { prefixCommit } from "@/util/commit"
import { fileToBase64 } from "@/util/fileBytes"

// A file the student picked, with its repo-relative path. `path` is the drop's
// relative path (or the bare name) — POSIX-normalized by the caller.
export type UploadFile = {
  path: string
  file: File
}

// Paths carried over verbatim from the current tree into a replace-all snapshot.
// The autograde workflow (.github/**) MUST survive — without it the push doesn't
// grade — and .classroom50.yaml is the control marker the runner reads. Anything
// else the student previously had is dropped (a full snapshot, matching the
// submit model the teacher chose).
const isPreservedPath = (path: string): boolean =>
  path === ".classroom50.yaml" ||
  path === ".github" ||
  path.startsWith(".github/")

export type SubmitAssignmentResult = {
  commitSha: string
  branch: string
  fileCount: number
}

// Commit the uploaded files as a snapshot on the student repo's default branch —
// the browser equivalent of `gh student submit`. A push to the default branch is
// what triggers autograding (the runner then tags submit/* and publishes the
// scored release), and a user-OAuth-token commit fires on:push normally, so no
// tag/release is created here.
//
// Snapshot semantics (replace-all): the new tree is AUTHORITATIVE (built without
// base_tree), so only the uploaded files plus the preserved control paths
// (.github/**, .classroom50.yaml) remain — prior submission files not re-uploaded
// are dropped. The whole read→build→commit→update runs inside withFreshRepoRetry
// to ride out transient git-data lag; a truncated tree read aborts rather than
// build a partial (destructive) snapshot.
export async function submitAssignment(params: {
  client: GitHubClient
  org: string
  repo: string
  assignment: string
  files: UploadFile[]
}): Promise<SubmitAssignmentResult> {
  const { client, org, repo, assignment, files } = params

  if (files.length === 0) {
    throw new Error("No files selected to submit.")
  }

  // Encode file bytes once, outside the retry loop — the blobs are re-POSTed per
  // attempt but the (potentially large) base64 conversion shouldn't repeat.
  const encoded = await Promise.all(
    files.map(async (f) => ({
      path: normalizeRepoPath(f.path),
      base64: await fileToBase64(f.file),
    })),
  )

  let result!: SubmitAssignmentResult
  await withFreshRepoRetry(async () => {
    // Resolve the live default branch each attempt (may be `master`, not `main`;
    // pushing to the wrong branch silently skips grading).
    const live = await getRepo(client, org, repo)
    const branch = live?.default_branch
    if (!branch) throw new Error(`Could not resolve ${org}/${repo}.`)

    const ref = await getBranchRefRepo(client, org, repo, branch)
    const parentSha = ref.object.sha
    const parentCommit = await getCommitByRepo(client, org, repo, parentSha)
    const baseTreeSha = parentCommit.tree?.sha
    if (!parentSha || !baseTreeSha) {
      throw new Error(
        `${org}/${repo} is not ready yet — try again in a moment.`,
      )
    }

    // Carry over the preserved control paths by their existing blob SHAs. Refuse
    // a truncated listing: building an authoritative tree from a partial read
    // would silently drop the autograde workflow (breaking grading).
    const existing = await getRepoTreeRecursive({
      client,
      owner: org,
      repo,
      treeSha: baseTreeSha,
    })
    if (existing.truncated) {
      throw new Error(
        "Your repository is too large to submit from the browser — use `gh student submit` from the CLI instead.",
      )
    }
    const preserved: GitHubTreeEntryFull[] = existing.tree.filter(
      (e) => e.type === "blob" && isPreservedPath(e.path),
    )

    // Upload the picked files as base64 blobs, then reference them by SHA. An
    // uploaded path that collides with a preserved control path is ignored on
    // the preserved side (the upload wins) — but control paths are hidden from
    // the picker, so this is defense-in-depth.
    const uploadedPaths = new Set(encoded.map((e) => e.path))
    const uploadedEntries: GitHubTreeEntryFull[] = await Promise.all(
      encoded.map(async (e) => {
        const blob = await createBlobForRepo({
          client,
          owner: org,
          repo,
          content: e.base64,
          encoding: "base64",
          timeoutMs: 60_000,
        })
        return {
          path: e.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blob.sha,
        }
      }),
    )

    const tree = [
      ...uploadedEntries,
      ...preserved.filter((e) => !uploadedPaths.has(e.path)),
    ]

    const newTree = await createTreeFromFullEntries({
      client,
      owner: org,
      repo,
      tree,
    })

    const commit = await createCommitForAssignment({
      client,
      owner: org,
      repo,
      message: prefixCommit(`Submit ${assignment}`),
      treeSha: newTree.sha,
      parentSha,
    })

    await updateRefForRepo({
      client,
      owner: org,
      repo,
      branch,
      commitSha: commit.sha,
    })

    result = {
      commitSha: commit.sha,
      branch,
      fileCount: uploadedEntries.length,
    }
  })

  return result
}

// Normalize a drop-relative path to a POSIX repo path: forward slashes, no
// leading `./` or `/`, and reject `..` traversal (a path escaping the repo root).
export function normalizeRepoPath(raw: string): string {
  const p = raw.replace(/\\/g, "/").replace(/^\.?\/+/, "")
  if (p.split("/").some((seg) => seg === "..")) {
    throw new Error(`Unsafe file path: ${raw}`)
  }
  return p
}
