import { useMutation } from "@tanstack/react-query"

import { fetchRepoArchive } from "@/github-core/repoArchiveReads"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { downloadBlob } from "@/util/downloadBlob"
import {
  pickSaveFile,
  supportsSaveFilePicker,
  writeToFileHandle,
} from "@/util/fileSystemAccess"
import { studentRepoName } from "@/util/studentRepo"

export type DownloadSubmissionInput = {
  org: string
  classroom: string
  assignment: string
  owner: string
}

// Download one student's latest submission. Chromium lets the teacher pick the
// save location (picked first, inside the click's activation); other browsers
// auto-download. A missing/empty repo → null archive → throws "no-submission"
// so the caller can say "nothing to download". A cancelled picker is a no-op.
export function useDownloadSubmission() {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: async ({
      org,
      classroom,
      assignment,
      owner,
    }: DownloadSubmissionInput) => {
      const filename = `${classroom}-${assignment}-${owner}.zip`

      // Open the picker first, inside the click's activation, before the fetch
      // — else the gesture would have expired. Null means cancelled.
      const usePicker = supportsSaveFilePicker()
      const handle = usePicker ? await pickSaveFile(filename) : null
      if (usePicker && !handle) return

      const repo = studentRepoName(classroom, assignment, owner)
      const archive = await fetchRepoArchive(client, org, repo)
      if (!archive) {
        throw new Error("no-submission")
      }

      if (handle) {
        await writeToFileHandle(handle, archive.bytes)
      } else {
        downloadBlob(new Blob([archive.bytes]), filename)
      }
    },
  })
}

export default useDownloadSubmission
