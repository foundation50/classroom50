import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys, invalidateGroupTeams } from "@/github-core/queries"
import { recoverGroupTeam } from "@/domain/teams/groupTeams"
import type {
  GroupTeamPrivacy,
  RecoverGroupTeamMember,
} from "@/domain/teams/groupTeams"

// Recover a deleted group team behind a surviving group repo: recreate the
// team at the repo's exact counter, add the chosen members, re-attach the
// repo, drop the creating teacher, then re-enable notifications. The mutation
// resolves even with per-step warnings (the result carries them), so it
// invalidates on settle and the rows show reality either way.
export function useRecoverGroupTeam(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    mutationFn: (input: {
      n: number
      displayName?: string
      privacy: GroupTeamPrivacy
      members: readonly RecoverGroupTeamMember[]
      repo: string
      creatorLogin: string
    }) =>
      recoverGroupTeam(client, org, {
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

export default useRecoverGroupTeam
