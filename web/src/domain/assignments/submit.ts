import type { GitHubClient } from "@/github-core/client"
import {
  createBlobForRepo,
  createCommitForAssignment,
  createTagRefForRepo,
  createTreeFromFullEntries,
  findSubmitTagAtSha,
  getRepoTreeRecursive,
  updateRefForRepo,
  type GitHubTreeEntryFull,
} from "@/github-core/mutations"
import { SUBMISSION_TAG_PREFIX } from "@/github-core/queries/releaseRunReads"
import { getRepo } from "@/github-core/repoReads"
import {
  getBranchRefRepo,
  getCommitByRepo,
  withFreshRepoRetry,
  REPO_READ_CONCURRENCY,
} from "@/github-core/queries"
import { prefixCommit } from "@/util/commit"
import { fileToBase64 } from "@/util/fileBytes"
import { mapWithConcurrency } from "@/util/concurrency"
import type { SubmissionMode } from "@/types/classroom"

// A file the student picked, with its repo-relative path. `path` is the drop's
// relative path (or the bare name) — POSIX-normalized by the caller.
export type UploadFile = {
  path: string
  file: File
}

// Control paths the runner owns: the autograde workflow (.github/**) and the
// .classroom50.yaml marker. On a submit they are carried over from the current
// tree and an upload may not overwrite them — losing .github/** would silently
// break grading. Shared with the UI so both layers reject/preserve the same set.
export const isReservedUploadPath = (path: string): boolean =>
  path === ".classroom50.yaml" ||
  path === ".github" ||
  path.startsWith(".github/")

export type SubmitAssignmentResult = {
  commitSha: string
  branch: string
  fileCount: number
  // The submit/* tag pushed (tag mode only; created fresh or reused when the
  // commit already carries one).
  tag?: string
}

// Tag-mode partial failure: the snapshot commit LANDED on the default branch
// but the submit/* tag push (the write that triggers grading) failed. Callers
// must not report this as an upload failure — the files are safe; only grading
// wasn't triggered, and a retry reuses the landed commit via the tag probe.
export class SubmitTagPushError extends Error {
  readonly commitSha: string
  constructor(commitSha: string, cause: unknown) {
    super(
      `Files were uploaded (commit ${commitSha}), but pushing the submit tag that triggers grading failed. Submit again to retry — the uploaded work is safe.`,
    )
    this.name = "SubmitTagPushError"
    this.commitSha = commitSha
    this.cause = cause
  }
}

// Commit the uploaded files as a replace-all snapshot on the student repo's
// default branch — the browser equivalent of `gh student submit`. The push
// (authored with the user's OAuth token) fires on:push and triggers autograding.
// For a tag-mode assignment (submission_mode: "tag") branch pushes are not
// graded, so a submit/<UTC-timestamp>-<short-sha> tag is additionally pushed —
// that tag push is what triggers grading.
//
// The new tree is AUTHORITATIVE (no base_tree), so prior files not re-uploaded
// are dropped; the runner's control paths (.github/**, .classroom50.yaml) are
// carried over so grading keeps working. A truncated tree read aborts here — see
// getRepoTreeRecursive for why a partial read is destructive.
export async function submitAssignment(params: {
  client: GitHubClient
  org: string
  repo: string
  assignment: string
  files: UploadFile[]
  submissionMode?: SubmissionMode
}): Promise<SubmitAssignmentResult> {
  const { client, org, repo, assignment, files, submissionMode } = params

  if (files.length === 0) {
    throw new Error("No files selected to submit.")
  }

  // Normalize + dedupe uploaded paths (last pick wins) and reject reserved
  // control paths — the domain owns this invariant, not the UI. Encode bytes
  // once here, outside the retry loop, so the (large) base64 work never repeats.
  const byPath = new Map<string, UploadFile>()
  for (const f of files) {
    const path = normalizeRepoPath(f.path)
    if (isReservedUploadPath(path)) continue
    byPath.set(path, { path, file: f.file })
  }
  const encoded = await Promise.all(
    Array.from(byPath.values(), async (f) => ({
      path: f.path,
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

    // Read the current tree so the runner's control paths carry over. Refuse a
    // truncated listing: an authoritative tree built from a partial read would
    // silently drop the autograde workflow (breaking grading).
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
    // Carry over the control paths by their existing blob SHAs.
    const preserved: GitHubTreeEntryFull[] = existing.tree.filter(
      (e) => e.type === "blob" && isReservedUploadPath(e.path),
    )

    // Upload the picked files as base64 blobs, then reference them by SHA. Bound
    // the fan-out at REPO_READ_CONCURRENCY so a large submit stays under GitHub's
    // secondary-rate-limit threshold (and a retry doesn't re-burst).
    const uploadedEntries = await mapWithConcurrency(
      encoded,
      REPO_READ_CONCURRENCY,
      async (e): Promise<GitHubTreeEntryFull> => {
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
      },
    )

    // Reserved paths were filtered out of `encoded`, so preserved control paths
    // can't collide with an upload — carry them all through unconditionally.
    const tree = [...uploadedEntries, ...preserved]

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

  // Tag-mode assignments grade ONLY on submit/* tag pushes, so push the tag
  // with the user's token after the branch update (user pushes fire
  // workflows). Outside the fresh-repo retry: the commit exists by now, and a
  // tag-push failure must surface as its own actionable error, not re-run the
  // whole snapshot. Reuse an existing submit/* tag at the same SHA (a retry,
  // or a hand-pushed tag) so one commit never grades twice. Every-push
  // assignments must NOT get a tag here — the branch push already grades.
  if (submissionMode === "tag") {
    const existing = await findSubmitTagAtSha({
      client,
      owner: org,
      repo,
      sha: result.commitSha,
    }).catch(() => null) // probe failure → fall through to a fresh tag
    if (existing) {
      result.tag = existing
    } else {
      const tag = buildSubmitTag(result.commitSha)
      try {
        await createTagRefForRepo({
          client,
          owner: org,
          repo,
          tag,
          commitSha: result.commitSha,
        })
      } catch (err) {
        // The commit landed; only the grading trigger failed. Surface a typed
        // error so the UI can say "uploaded but not graded — retry" instead of
        // the false "couldn't upload your files".
        throw new SubmitTagPushError(result.commitSha, err)
      }
      result.tag = tag
    }
  }

  return result
}

// The canonical submission tag for a commit: submit/<UTC-timestamp>-<short-sha>.
// Byte-format-identical with the runner's tag-minting step and the CLI's
// contract.BuildSubmitTag — the short-SHA suffix prevents collisions when two
// submissions land in the same UTC second.
export function buildSubmitTag(sha: string, now: Date = new Date()): string {
  const ts = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "-")
  return `${SUBMISSION_TAG_PREFIX}${ts}-${sha.slice(0, 7)}`
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
