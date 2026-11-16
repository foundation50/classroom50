import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  githubKeys,
  invalidateAssignments,
  invalidateGroupTeams,
} from "@/github-core/queries"
import { deleteGroupTeam } from "@/domain/teams/groupTeams"
import { recordGroupTeamDeletion } from "@/domain/teams/groupCounters"

// Delete a group team: record the deletion in the config repo (drop its
// teams.json row, retire its counter on the assignment entry), THEN delete the
// team (fail-closed guards in the domain layer). Bookkeeping goes first
// because it is what keeps the counter from being handed out again while the
// group's repo survives (#1128): a failed commit aborts before anything is
// destroyed, and a failed delete afterwards only leaves a live team the
// drift badge restores on the next sync.
export function useDeleteGroupTeam(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: async (input: { slug: string; id: number; n: number }) => {
      await recordGroupTeamDeletion(client, {
        org,
        classroom,
        assignment,
        slug: input.slug,
        n: input.n,
      })
      await deleteGroupTeam(client, org, {
        slug: input.slug,
        id: input.id,
        classroom,
        assignment,
      })
    },
    onSuccess: (_data, input) => {
      invalidateGroupTeams(queryClient, org, classroom, assignment, input.slug)
      void queryClient.invalidateQueries({
        queryKey: githubKeys.teamsFile(org, classroom),
      })
      invalidateAssignments(queryClient, org, classroom)
    },
  })
}

export default useDeleteGroupTeam
