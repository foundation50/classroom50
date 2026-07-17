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

// Self-repair "claim teacher": ensure-and-grant the classroom's teacher
// team, then idempotently add the acting owner to it. Hook invalidates the
// teacher team's members + the viewer's team-membership (what the role
// context reads); success/error toasts stay at the call site (see ./README.md).
export function useClaimTeacher(
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
        "teacher",
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
          classroomTeamSlug(classroom, "teacher"),
        ),
      })
      // Re-resolve the viewer's classroom role: their teacher-team membership
      // is what the role context reads.
      queryClient.invalidateQueries({
        queryKey: [
          "team-membership",
          org,
          classroomTeamSlug(classroom, "teacher"),
          username,
        ],
      })
    },
  })
}
