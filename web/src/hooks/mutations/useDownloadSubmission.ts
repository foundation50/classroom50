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

// Download one student's latest submission (their assignment repo's default
// branch, zipped by GitHub). Where the File System Access API is available
// (Chromium), the teacher first picks the save location; elsewhere it falls
// back to an automatic download into the browser's Downloads folder. Either way
// the file is `<classroom>-<assignment>-<owner>.zip`. A missing/empty repo
// resolves to a null archive; the mutation errors so the caller can surface
// "nothing to download". A cancelled save picker is a benign no-op.
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

      // Open the picker first, inside the click's transient activation, before
      // the archive fetch — otherwise the gesture would have expired by the
      // time we call it. Null means the user cancelled the picker.
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
