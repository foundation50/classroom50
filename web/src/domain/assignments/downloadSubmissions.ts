import JSZip from "jszip"

import { fetchRepoArchive } from "@/github-core/repoArchiveReads"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { mapWithConcurrency } from "@/util/concurrency"
import { writeFileToDirectory } from "@/util/fileSystemAccess"
import { studentRepoName } from "@/util/studentRepo"
import type { GitHubClient } from "@/github-core/client"

export type DownloadAllProgress = {
  done: number
  total: number
}

// Per-owner outcome: `fetched` packaged/written, `empty` was a missing/never-
// pushed repo (skipped), `failed` errored (recorded, not fatal).
export type DownloadOutcome = "fetched" | "empty" | "failed"

export type DownloadRepoResult = {
  owner: string
  outcome: DownloadOutcome
  reason?: string
}

export type DownloadAllSummary = {
  total: number
  fetched: number
  empty: DownloadRepoResult[]
  failed: DownloadRepoResult[]
  results: DownloadRepoResult[]
}

export type DownloadAllResult = {
  blob: Blob
  summary: DownloadAllSummary
}

// Advisory confirm-step threshold: past this, the combined zip is large enough
// to risk exhausting the tab (whole archive built in memory). Not enforced.
export const BULK_DOWNLOAD_WARN_THRESHOLD = 100

// Combined-zip assembly failed (usually OOM on a large class). Distinct from a
// per-repo failure so the UI can say "too big" instead of a generic error.
export class ZipAssemblyError extends Error {
  constructor(cause: unknown) {
    super("Failed to assemble the combined submissions archive", { cause })
    this.name = "ZipAssemblyError"
  }
}

// Case-insensitive dedupe (GitHub logins aren't case-sensitive) so a repeated
// owner can't yield two identical entries.
function dedupeOwners(owners: string[]): string[] {
  const seen = new Set<string>()
  return owners.filter((owner) => {
    const key = owner.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Classify a caught per-owner error: a user cancel (abort) is not a repo
// failure, so it's recorded as skipped rather than inflating the failed bucket.
function classifyOwnerError(
  owner: string,
  err: unknown,
  aborted: boolean,
): DownloadRepoResult {
  const isAbort =
    aborted || (err instanceof DOMException && err.name === "AbortError")
  return {
    owner,
    outcome: isAbort ? "empty" : "failed",
    reason: isAbort
      ? "cancelled"
      : err instanceof Error
        ? err.message
        : String(err),
  }
}

function summarize(
  owners: string[],
  results: DownloadRepoResult[],
): DownloadAllSummary {
  return {
    total: owners.length,
    fetched: results.filter((r) => r.outcome === "fetched").length,
    empty: results.filter((r) => r.outcome === "empty"),
    failed: results.filter((r) => r.outcome === "failed"),
    results,
  }
}

// Shared fan-out: fetch each owner's archive at bounded concurrency, invoking
// `onArchive` with each fetched repo's bytes; one repo's failure is recorded,
// never aborting the batch.
async function fanOutArchives(params: {
  client: GitHubClient
  org: string
  classroom: string
  assignment: string
  owners: string[]
  onArchive: (owner: string, bytes: ArrayBuffer) => Promise<void> | void
  onProgress?: (progress: DownloadAllProgress) => void
  signal?: AbortSignal
}): Promise<DownloadRepoResult[]> {
  const { client, org, classroom, assignment, owners, onArchive } = params
  const total = owners.length
  let done = 0

  return mapWithConcurrency(
    owners,
    REPO_READ_CONCURRENCY,
    async (owner): Promise<DownloadRepoResult> => {
      let result: DownloadRepoResult
      if (params.signal?.aborted) {
        result = { owner, outcome: "empty", reason: "cancelled" }
      } else {
        try {
          const repo = studentRepoName(classroom, assignment, owner)
          const archive = await fetchRepoArchive(client, org, repo, {
            signal: params.signal,
          })
          if (archive) {
            await onArchive(owner, archive.bytes)
            result = { owner, outcome: "fetched" }
          } else {
            result = { owner, outcome: "empty" }
          }
        } catch (err) {
          result = classifyOwnerError(owner, err, !!params.signal?.aborted)
        }
      }
      done++
      params.onProgress?.({ done, total })
      return result
    },
  )
}

// Fallback path (no File System Access API): fetch every submission and store
// each losslessly as a nested `<owner>.zip` in one combined in-memory zip.
export async function downloadAllSubmissions(params: {
  client: GitHubClient
  org: string
  classroom: string
  assignment: string
  owners: string[]
  onProgress?: (progress: DownloadAllProgress) => void
  signal?: AbortSignal
}): Promise<DownloadAllResult> {
  const owners = dedupeOwners(params.owners)
  const zip = new JSZip()

  const results = await fanOutArchives({
    ...params,
    owners,
    onArchive: (owner, bytes) => {
      zip.file(`${owner}.zip`, bytes)
    },
  })

  let blob: Blob
  try {
    blob = await zip.generateAsync({ type: "blob" })
  } catch (err) {
    // Every archive already downloaded; the failure is assembling them (most
    // likely an out-of-memory allocation for a very large class).
    throw new ZipAssemblyError(err)
  }

  return { blob, summary: summarize(owners, results) }
}

// Chromium path: stream each submission straight to `<owner>.zip` in the picked
// folder as it arrives — nothing buffered, so no combined-zip ceiling.
export async function streamSubmissionsToDirectory(params: {
  client: GitHubClient
  org: string
  classroom: string
  assignment: string
  owners: string[]
  directory: FileSystemDirectoryHandle
  onProgress?: (progress: DownloadAllProgress) => void
  signal?: AbortSignal
}): Promise<DownloadAllSummary> {
  const owners = dedupeOwners(params.owners)

  const results = await fanOutArchives({
    ...params,
    owners,
    onArchive: (owner, bytes) =>
      writeFileToDirectory(params.directory, `${owner}.zip`, bytes),
  })

  return summarize(owners, results)
}
