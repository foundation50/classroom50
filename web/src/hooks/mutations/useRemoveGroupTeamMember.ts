import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { invalidateGroupTeams } from "@/github-core/queries"
import { removeGroupTeamMember } from "@/domain/teams/groupTeams"

// Remove a member from a group team (idempotent; 404 = already gone).
export function useRemoveGroupTeamMember(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    mutationFn: (input: { teamSlug: string; username: string }) =>
      removeGroupTeamMember(client, org, input),
    onSuccess: (_data, input) => {
      invalidateGroupTeams(
        queryClient,
        org,
        classroom,
        assignment,
        input.teamSlug,
      )
    },
  })
}

export default useRemoveGroupTeamMember
