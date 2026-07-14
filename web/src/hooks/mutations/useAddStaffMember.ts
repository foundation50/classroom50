import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { githubKeys, getUserQuery } from "@/github-core/queries"
import {
  addUserToTeam,
  ensureClassroomRoleTeam,
  grantTeamConfigRepoWrite,
  removeUserFromTeam,
} from "@/github-core/mutations"
import { syncRosterFromTeam } from "@/domain/students"
import { normalizeGithubUsername } from "@/domain/students"
import { classroomTeamSlug } from "@/util/teamSlug"
import { rosterPath } from "@/util/rosterPath"
import { CONFIG_REPO } from "@/util/configRepo"
import { logger } from "@/lib/logger"
import type { StaffRole } from "@/types/classroom"

const log = logger.scope("classroom:staff")

// Best-effort: reflect a staff change into roster.csv so the roster page shows
// it without waiting for its own on-open auto-sync. Non-fatal — the roster page
// converges on next open — so a failure never surfaces on the staff action.
// Exported for reuse by the sibling remove/resend staff mutations.
export async function syncRosterAfterStaffChange(
  client: Parameters<typeof syncRosterFromTeam>[0],
  queryClient: import("@tanstack/react-query").QueryClient,
  org: string,
  classroom: string,
): Promise<void> {
  try {
    await syncRosterFromTeam(client, { org, classroom })
    await queryClient.invalidateQueries({
      queryKey: githubKeys.csvFile(org, CONFIG_REPO, rosterPath(classroom)),
    })
  } catch (err) {
    log.debug("roster sync after staff change failed (non-fatal)", {
      org,
      classroom,
      err,
    })
  }
}

// Add a staff member (instructor/ta) to a classroom's role team. The multi-step
// chain — verify the account exists, ensure-and-grant the role team, strip the
// auto-added creator on a fresh team, add the target — lives here behind one
// named mutation. Hook invalidates team-members + best-effort roster sync; the
// empty-the-field/toast/error-map effects stay at the call site (see
// ./README.md).
export function useAddStaffMember(
  org: string,
  classroom: string,
  messages: { enterUsername: string },
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { user } = useGithubAuth()

  return useMutation({
    mutationFn: async (input: { username: string; role: StaffRole }) => {
      const trimmed = normalizeGithubUsername(input.username)
      if (!trimmed) throw new Error(messages.enterUsername)
      // Verify the account exists for a clear error (vs. a confusing team 422).
      await queryClient.ensureQueryData(getUserQuery(client, trimmed))
      // Ensure-as-preflight: create the team if missing + (re)grant config write.
      const team = await ensureClassroomRoleTeam(
        client,
        org,
        classroom,
        input.role,
      )
      await grantTeamConfigRepoWrite(client, org, team.slug)
      // GitHub auto-adds the team CREATOR as maintainer. If this action just
      // created the team, remove the acting user unless they're the target — so
      // adding a TA doesn't also make the instructor a TA.
      if (
        team.created &&
        user?.login &&
        user.login.toLowerCase() !== trimmed.toLowerCase()
      ) {
        try {
          await removeUserFromTeam(client, {
            org,
            teamSlug: team.slug,
            username: user.login,
          })
        } catch {
          // Best-effort; the actor can remove themselves via this same UI.
        }
      }
      await addUserToTeam(client, {
        org,
        teamSlug: team.slug,
        username: trimmed,
        role: "member",
      })
      return { trimmed, role: input.role }
    },
    onSuccess: ({ role: addedRole }) => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamMembers(
          org,
          classroomTeamSlug(classroom, addedRole),
        ),
      })
      // Record the new staffer's role in roster.csv now (best-effort).
      void syncRosterAfterStaffChange(client, queryClient, org, classroom)
    },
  })
}
