import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { githubKeys, invalidateClassroomTeam } from "@/github-core/queries"
import { addClassroomStaffMember, syncRosterFromTeam } from "@/domain/students"
import { resolveClassroomRoleSlug } from "@/util/teamSlug"
import useGetClassroom from "@/hooks/useGetClassroom"
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

// Add a staff member (teacher/ta) to a classroom's role team. The multi-step
// GitHub chain lives in the shared domain function addClassroomStaffMember (the
// same @/domain/students layer the roster view uses); this hook is the thin
// wrapper that self-invalidates the bound team's members + invitations and runs
// the best-effort roster sync. The empty-the-field/toast/error-map effects stay
// at the call site (see ./README.md).
export function useAddStaffMember(
  org: string,
  classroom: string,
  messages: { enterUsername: string },
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { data: classroomJson } = useGetClassroom(org, classroom)

  return useMutation({
    mutationFn: async (input: { username: string; role: StaffRole }) => {
      if (!input.username.trim()) throw new Error(messages.enterUsername)
      const { username, role } = await addClassroomStaffMember(client, {
        org,
        classroom,
        username: input.username,
        role: input.role,
      })
      // Call site expects `trimmed` for its success toast.
      return { trimmed: username, role }
    },
    onSuccess: ({ role: addedRole }) => {
      // Resolve the added role's slug from classroom.json (GitHub can rewrite a
      // slug on a name collision), matching the read in StaffRoleList so the
      // invalidation can't miss a team whose stored slug differs from derived.
      const teamSlug = resolveClassroomRoleSlug(
        classroom,
        addedRole,
        classroomJson,
      )
      // A non-member add creates a pending invite (not a member), so refresh
      // both lists — invitations alone were previously missed (issue #348).
      invalidateClassroomTeam(queryClient, org, teamSlug)
      // Record the new staffer's role in roster.csv now (best-effort).
      void syncRosterAfterStaffChange(client, queryClient, org, classroom)
    },
  })
}
