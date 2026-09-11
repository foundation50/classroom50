import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { cancelPagesDeployment } from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"

// Cancel the Pages deployment blocking a later publish, so the failed deploy can
// be re-run now instead of after GitHub's ~10-minute release. Only frees the
// lock; the caller re-runs the failed job as its own step so each outcome is
// reported separately. Optional client because the banner mounts above auth.
export function useCancelPagesDeployment() {
  const client = useOptionalGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      org,
      deploymentId,
    }: {
      org: string
      deploymentId: string
    }) => {
      if (!client) throw new Error("GitHub client is not ready")
      return cancelPagesDeployment(client, org, deploymentId)
    },
    onSettled: (_data, _err, { org, deploymentId }) => {
      // Re-read the blocker so the failure row reflects whichever way it went.
      void queryClient.invalidateQueries({
        queryKey: githubKeys.pagesDeployment(org, deploymentId),
      })
    },
  })
}

export default useCancelPagesDeployment
