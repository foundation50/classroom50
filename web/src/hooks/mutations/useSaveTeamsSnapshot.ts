import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys } from "@/github-core/queries"
import { saveTeamsSnapshot, syncTeamsSnapshot } from "@/domain/teams/teamsFile"
import type { TeamsFileTeam } from "@/domain/teams/teamsFile"
import type { TeamFormation } from "@/types/classroom"

// Snapshot one assignment's group teams into <classroom>/teams.json (the
// teacher-side source of truth / drift baseline).
export function useSaveTeamsSnapshot(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    mutationFn: (input: { teams: TeamsFileTeam[] }) =>
      saveTeamsSnapshot(client, {
        org,
        classroom,
        assignment,
        teams: input.teams,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.teamsFile(org, classroom),
      })
    },
  })
}

export default useSaveTeamsSnapshot

// Re-derive the snapshot from live team state and commit it — the write every
// teacher-side team mutation follows, and the drift note's refresh action.
export function useSyncTeamsSnapshot(params: {
  org: string
  classroom: string
  assignment: string
}) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { org, classroom, assignment } = params

  return useMutation({
    mutationFn: (input: { formation: TeamFormation }) =>
      syncTeamsSnapshot(client, {
        org,
        classroom,
        assignment,
        formation: input.formation,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: githubKeys.teamsFile(org, classroom),
      })
    },
  })
}
