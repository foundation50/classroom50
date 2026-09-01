import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { invalidateGroupTeams } from "@/github-core/queries"
import { updateGroupTeamPrivacy } from "@/domain/teams/groupTeams"
import type { GroupTeamPrivacy } from "@/domain/teams/groupTeams"

// Flip a group team's privacy (visible `closed` <-> hidden `secret`). Privacy
// isn't recorded in teams.json, so no snapshot sync follows — the group-team
// caches are invalidated so the listing re-reads the new value.
export function useUpdateGroupTeamPrivacy(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    mutationFn: (input: { teamSlug: string; privacy: GroupTeamPrivacy }) =>
      updateGroupTeamPrivacy(client, org, {
        slug: input.teamSlug,
        privacy: input.privacy,
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

export default useUpdateGroupTeamPrivacy
