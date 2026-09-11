import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useOptionalGitHubClient } from "@/context/github/GitHubProvider"
import { cancelPagesDeployment } from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"

// Cancel the Pages deployment GitHub named as blocking a later publish, so the
// failed deploy job can be re-run at once instead of waiting out GitHub's
// ~10-minute lock. Cancelling only frees the lock; the caller re-runs the
// failed job (rerunFailedRun) as its own step so a cancel that succeeds but a
// retry that fails is reported as such. Optional client because the banner
// mounts above auth, like useActionActivity.
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
      // Re-read the blocker so the failure row reflects the cleared (or still
      // held) lock, whichever way the cancel went.
      void queryClient.invalidateQueries({
        queryKey: githubKeys.pagesDeployment(org, deploymentId),
      })
    },
  })
}

export default useCancelPagesDeployment
