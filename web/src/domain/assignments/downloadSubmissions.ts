import JSZip from "jszip"

import { fetchRepoArchive } from "@/github-core/repoArchiveReads"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { mapWithConcurrency } from "@/util/concurrency"
import { studentRepoName } from "@/util/studentRepo"
import type { GitHubClient } from "@/github-core/client"

export type DownloadAllProgress = {
  done: number
  total: number
}

// Per-owner outcome: `fetched` packaged into the combined zip, `empty` was a
// missing/never-pushed repo (skipped), `failed` errored (recorded, not fatal).
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

// Soft ceiling on how many submissions one bulk run packages. The whole
// combined zip is built in browser memory (every archive buffered, then a
// second full copy from generateAsync), so a very large class can exhaust the
// tab. The UI warns past this in the confirm step; it's advisory, not enforced
// here — a teacher who accepts the warning still gets the full run.
export const BULK_DOWNLOAD_WARN_THRESHOLD = 100

// Thrown when the combined zip can't be assembled (typically an allocation
// failure because the class is too large to hold in memory). Distinct from a
// per-repo network failure so the UI can tell the teacher the class is too big
// rather than showing a generic error after every archive already downloaded.
export class ZipAssemblyError extends Error {
  constructor(cause: unknown) {
    super("Failed to assemble the combined submissions archive", { cause })
    this.name = "ZipAssemblyError"
  }
}

// Download EVERY submitting owner's latest submission into one combined zip
// (single teacher action). A bounded fan-out (REPO_READ_CONCURRENCY) fetches
// each repo's archive; each fetched archive is stored — not re-inflated — as a
// nested `<owner>.zip` entry, so a large class stays lossless and cheap to
// package. A missing/empty repo is skipped, and a single repo's failure is
// recorded rather than aborting the batch. `onProgress` fires after each repo
// settles so the UI can show a live count.
export async function downloadAllSubmissions(params: {
  client: GitHubClient
  org: string
  classroom: string
  assignment: string
  owners: string[]
  onProgress?: (progress: DownloadAllProgress) => void
  signal?: AbortSignal
}): Promise<DownloadAllResult> {
  const { client, org, classroom, assignment, onProgress, signal } = params
  // Dedupe (case-insensitively, matching the lowercased repo name) so a
  // duplicated owner can't add two identical entries to the combined zip.
  const seen = new Set<string>()
  const owners = params.owners.filter((owner) => {
    const key = owner.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const total = owners.length
  let done = 0

  const zip = new JSZip()

  const results = await mapWithConcurrency(
    owners,
    REPO_READ_CONCURRENCY,
    async (owner): Promise<DownloadRepoResult> => {
      let result: DownloadRepoResult
      if (signal?.aborted) {
        result = { owner, outcome: "empty", reason: "cancelled" }
      } else {
        try {
          const repo = studentRepoName(classroom, assignment, owner)
          const archive = await fetchRepoArchive(client, org, repo, { signal })
          result = archive
            ? { owner, outcome: "fetched" }
            : { owner, outcome: "empty" }
          if (archive) {
            zip.file(`${owner}.zip`, archive.bytes)
          }
        } catch (err) {
          // A user cancel (abort) is not a repo failure — classify it so the
          // summary doesn't report cancelled repos as failures.
          const aborted =
            signal?.aborted ||
            (err instanceof DOMException && err.name === "AbortError")
          result = {
            owner,
            outcome: aborted ? "empty" : "failed",
            reason: aborted
              ? "cancelled"
              : err instanceof Error
                ? err.message
                : String(err),
          }
        }
      }
      done++
      onProgress?.({ done, total })
      return result
    },
  )

  let blob: Blob
  try {
    blob = await zip.generateAsync({ type: "blob" })
  } catch (err) {
    // Every archive already downloaded; the failure is assembling them (most
    // likely an out-of-memory allocation for a very large class).
    throw new ZipAssemblyError(err)
  }

  return {
    blob,
    summary: {
      total,
      fetched: results.filter((r) => r.outcome === "fetched").length,
      empty: results.filter((r) => r.outcome === "empty"),
      failed: results.filter((r) => r.outcome === "failed"),
      results,
    },
  }
}
