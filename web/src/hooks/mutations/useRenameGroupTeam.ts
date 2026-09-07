import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { invalidateGroupTeams } from "@/github-core/queries"
import { updateGroupTeamDisplayName } from "@/domain/teams/groupTeams"

// Update a group team's DISPLAY name (the classroom50/group/v1 description
// record). The team name (== slug) never changes — the naming contract keeps
// repos, grading, and cleanup rename-proof. Callers that maintain teams.json
// follow up with useSyncTeamsSnapshot, like the other teacher-side mutations.
export function useRenameGroupTeam(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    mutationFn: (input: { teamSlug: string; name: string }) =>
      updateGroupTeamDisplayName(client, org, {
        slug: input.teamSlug,
        classroom,
        assignment,
        name: input.name,
      }),
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

export default useRenameGroupTeam
