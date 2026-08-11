import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { setAutogradeState } from "@/github-core/mutations"

type SetAutogradeStateVars = {
  org: string
  repo: string
  action: "pause" | "resume"
}

// Pause/resume autograding for one repo (per-row action in the manage hub).
// Invalidates the repo's autogradeState read on success so the row's label
// flips between Pause and Resume. Invalidation lives in onSuccess so a
// mid-flight unmount can't drop it.
export function useSetAutogradeState() {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation<
    { status: "ok" | "notGradable" },
    Error,
    SetAutogradeStateVars
  >({
    mutationFn: ({ org, repo, action }) =>
      setAutogradeState({ client, org, repo, action }),
    onSuccess: (_result, { org, repo }) => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.autogradeState(org, repo),
      })
    },
  })
}

export default useSetAutogradeState
