import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { getAutogradeState, type AutogradeState } from "@/github-core/mutations"

// The autograde workflow's live state for one repo, so a row action can show
// Pause (enabled) vs Resume (paused). Read lazily — the manage hub enables it
// only while open and only when a repo exists — and kept short-lived so the
// label reflects a just-applied pause/resume (the mutation also invalidates
// this key). A read failure leaves `data` undefined, which the UI treats as
// "state unknown" and falls back to a neutral affordance.
export function useGetAutogradeState(
  org: string | undefined,
  repo: string | undefined,
  options?: { enabled?: boolean },
) {
  const client = useGitHubClient()

  return useQuery<AutogradeState>({
    queryKey: githubKeys.autogradeState(org ?? "", repo ?? ""),
    queryFn: () =>
      getAutogradeState({ client, org: org ?? "", repo: repo ?? "" }),
    enabled: Boolean(org && repo) && (options?.enabled ?? true),
    staleTime: 0,
    retry: false,
  })
}

export default useGetAutogradeState
