import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys, invalidateGroupTeams } from "@/github-core/queries"
import { createGroupTeam } from "@/domain/teams/groupTeams"
import type { TeamFormation } from "@/types/classroom"

// Create a group team for a team-mode assignment. Student formation passes
// founderLogin === creatorLogin (the founding student stays maintainer);
// teacher formation omits founderLogin (the creating teacher is dropped).
export function useCreateGroupTeam(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: (input: {
      displayName?: string
      creatorLogin: string
      founderLogin?: string
      formation: TeamFormation
    }) =>
      createGroupTeam(client, org, {
        classroom,
        assignment,
        ...input,
      }),
    onSuccess: (created) => {
      invalidateGroupTeams(
        queryClient,
        org,
        classroom,
        assignment,
        created.slug,
      )
      void queryClient.invalidateQueries({
        queryKey: githubKeys.teamsFile(org, classroom),
      })
    },
  })
}

export default useCreateGroupTeam
