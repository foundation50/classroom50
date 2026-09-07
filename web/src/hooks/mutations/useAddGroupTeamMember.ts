import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { invalidateGroupTeams } from "@/github-core/queries"
import { addGroupTeamMember } from "@/domain/teams/groupTeams"

// Add a member to a group team, with the shared size + roster gate enforced in
// the domain layer.
export function useAddGroupTeamMember(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    mutationFn: (input: {
      teamSlug: string
      username: string
      role?: "member" | "maintainer"
      currentMemberCount: number
      maxGroupSize?: number
      rosterLogins?: ReadonlySet<string>
    }) => addGroupTeamMember(client, org, input),
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

export default useAddGroupTeamMember
