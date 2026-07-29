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
  const { client, org, classroom, assignment, owners, onProgress, signal } =
    params
  const total = owners.length
  let done = 0

  const zip = new JSZip()

  const results = await mapWithConcurrency(
    owners,
    REPO_READ_CONCURRENCY,
    async (owner): Promise<DownloadRepoResult> => {
      let result: DownloadRepoResult
      if (signal?.aborted) {
        result = { owner, outcome: "failed", reason: "aborted" }
      } else {
        try {
          const repo = studentRepoName(classroom, assignment, owner)
          const archive = await fetchRepoArchive(client, org, repo)
          result = archive
            ? { owner, outcome: "fetched" }
            : { owner, outcome: "empty" }
          if (archive) {
            zip.file(`${owner}.zip`, archive.bytes)
          }
        } catch (err) {
          result = {
            owner,
            outcome: "failed",
            reason: err instanceof Error ? err.message : String(err),
          }
        }
      }
      done++
      onProgress?.({ done, total })
      return result
    },
  )

  const blob = await zip.generateAsync({ type: "blob" })

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
