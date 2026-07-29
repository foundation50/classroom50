import { useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"

import { downloadAllSubmissions } from "@/domain/assignments"
import type {
  DownloadAllProgress,
  DownloadAllSummary,
} from "@/domain/assignments"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { downloadBlob } from "@/util/downloadBlob"

export type DownloadAllSubmissionsInput = {
  org: string
  classroom: string
  assignment: string
  owners: string[]
}

// Download EVERY submitting owner's latest submission as one combined zip
// (issue: teacher bulk download). Wraps the domain fan-out and exposes live
// `progress` (a plain useState updated from the batch's onProgress) alongside
// the mutation, so a modal can render an "X of N" bar while it runs. On success
// the combined blob is handed to the browser as
// `<classroom>-<assignment>-submissions.zip`; the returned summary lets the
// caller report fetched/empty/failed counts. `cancel` aborts an in-flight run
// (the in-flight archive fetches are cancelled too), letting the modal offer a
// Cancel button rather than trapping the teacher until it finishes.
export function useDownloadAllSubmissions() {
  const client = useGitHubClient()
  const [progress, setProgress] = useState<DownloadAllProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const mutation = useMutation<
    DownloadAllSummary,
    Error,
    DownloadAllSubmissionsInput
  >({
    mutationFn: async ({ org, classroom, assignment, owners }) => {
      const controller = new AbortController()
      abortRef.current = controller
      setProgress({ done: 0, total: owners.length })
      const { blob, summary } = await downloadAllSubmissions({
        client,
        org,
        classroom,
        assignment,
        owners,
        onProgress: setProgress,
        signal: controller.signal,
      })
      if (summary.fetched > 0) {
        downloadBlob(blob, `${classroom}-${assignment}-submissions.zip`)
      }
      return summary
    },
  })

  return {
    ...mutation,
    progress,
    cancel: () => abortRef.current?.abort(),
    reset: () => {
      abortRef.current = null
      setProgress(null)
      mutation.reset()
    },
  }
}

export default useDownloadAllSubmissions
