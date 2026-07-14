import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { classroomTeamSlug } from "@/util/teamSlug"
import {
  addUserToTeam,
  ensureClassroomRoleTeam,
  grantTeamConfigRepoWrite,
} from "@/github-core/mutations"
import { githubKeys } from "@/github-core/queries"

// Self-repair "claim instructor": ensure-and-grant the classroom's instructor
// team, then idempotently add the acting owner to it. Per the TanStack split
// (see hooks/mutations), the hook owns only the invalidation that must always
// run (the instructor team's members + the viewer's team-membership, which the
// role context reads); the caller passes success/error toasts via `mutate` so
// they skip when unmounted.
export function useClaimInstructor(
  org: string,
  classroom: string,
  messages: { somethingWentWrong: string },
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { user } = useGithubAuth()

  return useMutation({
    mutationFn: async () => {
      const username = user?.login
      if (!username) throw new Error(messages.somethingWentWrong)
      const team = await ensureClassroomRoleTeam(
        client,
        org,
        classroom,
        "instructor",
      )
      await grantTeamConfigRepoWrite(client, org, team.slug)
      // Idempotent: PUT membership is a no-op (200) if already a member.
      await addUserToTeam(client, {
        org,
        teamSlug: team.slug,
        username,
        role: "maintainer",
      })
      return { username }
    },
    onSuccess: ({ username }) => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamMembers(
          org,
          classroomTeamSlug(classroom, "instructor"),
        ),
      })
      // Re-resolve the viewer's classroom role: their instructor-team membership
      // is what the role context reads.
      queryClient.invalidateQueries({
        queryKey: [
          "team-membership",
          org,
          classroomTeamSlug(classroom, "instructor"),
          username,
        ],
      })
    },
  })
}
