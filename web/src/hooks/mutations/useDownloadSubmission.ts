import { useMutation } from "@tanstack/react-query"

import { fetchRepoArchive } from "@/github-core/repoArchiveReads"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { downloadBlob } from "@/util/downloadBlob"
import { studentRepoName } from "@/util/studentRepo"

export type DownloadSubmissionInput = {
  org: string
  classroom: string
  assignment: string
  owner: string
}

// Download one student's latest submission (their assignment repo's default
// branch, zipped by GitHub) and hand the bytes to the browser as
// `<classroom>-<assignment>-<owner>.zip`. A missing/empty repo resolves to a
// null archive; the mutation errors so the caller can surface "nothing to
// download".
export function useDownloadSubmission() {
  const client = useGitHubClient()

  return useMutation({
    mutationFn: async ({
      org,
      classroom,
      assignment,
      owner,
    }: DownloadSubmissionInput) => {
      const repo = studentRepoName(classroom, assignment, owner)
      const archive = await fetchRepoArchive(client, org, repo)
      if (!archive) {
        throw new Error("no-submission")
      }
      downloadBlob(
        new Blob([archive.bytes]),
        `${classroom}-${assignment}-${owner}.zip`,
      )
    },
  })
}

export default useDownloadSubmission
