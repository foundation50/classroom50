import { useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"

import {
  downloadAllSubmissions,
  streamSubmissionsToDirectory,
} from "@/domain/assignments"
import type {
  DownloadAllProgress,
  DownloadAllSummary,
} from "@/domain/assignments"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { downloadBlob } from "@/util/downloadBlob"
import { pickDirectory, supportsDirectoryPicker } from "@/util/fileSystemAccess"

export type DownloadAllSubmissionsInput = {
  org: string
  classroom: string
  assignment: string
  owners: string[]
}

// User dismissed the directory picker before the run started — reset quietly.
export type DownloadAllOutcome =
  | { status: "cancelled" }
  | { status: "done"; summary: DownloadAllSummary; toDirectory: boolean }

// Bulk download: Chromium streams each submission into a picked folder; other
// browsers get one combined auto-downloaded zip. `progress` drives the bar;
// `cancel` aborts the run and its in-flight fetches.
export function useDownloadAllSubmissions() {
  const client = useGitHubClient()
  const [progress, setProgress] = useState<DownloadAllProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const mutation = useMutation<
    DownloadAllOutcome,
    Error,
    DownloadAllSubmissionsInput
  >({
    mutationFn: async ({ org, classroom, assignment, owners }) => {
      // Pick the directory first, inside the click's activation, before any
      // fetch. Null means cancelled.
      const useDirectory = supportsDirectoryPicker()
      const directory = useDirectory ? await pickDirectory() : null
      if (useDirectory && !directory) {
        return { status: "cancelled" }
      }

      const controller = new AbortController()
      abortRef.current = controller
      setProgress({ done: 0, total: owners.length })

      if (directory) {
        const summary = await streamSubmissionsToDirectory({
          client,
          org,
          classroom,
          assignment,
          owners,
          directory,
          onProgress: setProgress,
          signal: controller.signal,
        })
        return { status: "done", summary, toDirectory: true }
      }

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
      return { status: "done", summary, toDirectory: false }
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
