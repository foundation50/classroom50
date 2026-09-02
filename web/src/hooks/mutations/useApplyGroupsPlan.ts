import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys, invalidateGroupTeams } from "@/github-core/queries"
import { applyGroupsPlan } from "@/domain/teams/copyGroupsPlan"
import type {
  ApplyGroupsPlanProgress,
  PlannedGroup,
} from "@/domain/teams/copyGroupsPlan"
import type { TeamFormation } from "@/types/classroom"

// Apply a "copy groups" plan to the current assignment: sequential team
// creates + member adds, one teams.json sync at the end. The mutation
// resolves even on a partial apply — the result carries what was created,
// member warnings, and any create failure — so it always invalidates the
// team caches and the view shows reality.
export function useApplyGroupsPlan(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    mutationFn: (input: {
      plan: readonly PlannedGroup[]
      formation: TeamFormation
      creatorLogin: string
      maxGroupSize?: number
      rosterLogins?: ReadonlySet<string>
      onProgress?: (progress: ApplyGroupsPlanProgress) => void
    }) =>
      applyGroupsPlan(client, org, {
        classroom,
        assignment,
        ...input,
      }),
    onSettled: () => {
      invalidateGroupTeams(queryClient, org, classroom, assignment)
      void queryClient.invalidateQueries({
        queryKey: githubKeys.teamsFile(org, classroom),
      })
    },
  })
}

export default useApplyGroupsPlan
