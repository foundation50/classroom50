import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { invalidateGroupTeams } from "@/github-core/queries"
import { leaveGroupTeam } from "@/domain/teams/groupTeams"

// The viewer leaves their own group team (student-formed assignments). The
// view gates this behind a typed confirmation — rejoining needs a new
// request-and-approval round on GitHub, so an accidental click must not be
// cheap. A 403 maps to a localized error in the domain layer.
export function useLeaveGroupTeam(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    mutationFn: (input: { teamSlug: string; username: string }) =>
      leaveGroupTeam(client, org, input),
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

export default useLeaveGroupTeam
