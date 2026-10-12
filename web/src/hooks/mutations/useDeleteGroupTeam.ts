import { useMutation, useQueryClient } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  githubKeys,
  invalidateGroupTeams,
  seedTeamsFile,
} from "@/github-core/queries"
import { deleteGroupTeam } from "@/domain/teams/groupTeams"
import {
  removeTeamFromSnapshot,
  writeTeamsFile,
  type TeamsFile,
} from "@/domain/teams/teamsFile"
import { logger } from "@/lib/logger"

const log = logger.scope("mutations:deleteGroupTeam")

// Delete a group team (fail-closed guards in the domain layer) and drop it
// from the teams.json snapshot. The snapshot write is best-effort: the team is
// already gone, so a failed follow-up commit only leaves a stale snapshot row
// the drift badge surfaces.
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
    mutationFn: async (input: {
      slug: string
      id: number
    }): Promise<{ teamsFile?: TeamsFile }> => {
      await deleteGroupTeam(client, org, {
        slug: input.slug,
        id: input.id,
        classroom,
        assignment,
      })
      try {
        const teamsFile = await writeTeamsFile(client, {
          org,
          classroom,
          message: `Update teams: ${classroom}/${assignment}`,
          update: (file) =>
            removeTeamFromSnapshot(file, assignment, input.slug),
        })
        return { teamsFile }
      } catch (err) {
        log.warn("teams.json cleanup after delete failed (non-fatal)", {
          org,
          classroom,
          assignment,
          slug: input.slug,
          err,
        })
        return {}
      }
    },
    onSuccess: ({ teamsFile }, input) => {
      invalidateGroupTeams(queryClient, org, classroom, assignment, input.slug)
      // Seed from the commit when it landed; a failed cleanup left the file
      // as it was, so refetch and let the drift badge report the stale row.
      if (teamsFile) {
        seedTeamsFile(queryClient, org, classroom, teamsFile)
      } else {
        void queryClient.invalidateQueries({
          queryKey: githubKeys.teamsFile(org, classroom),
        })
      }
    },
  })
}

export default useDeleteGroupTeam
