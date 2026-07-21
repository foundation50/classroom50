import { useMutation, useQueryClient } from "@tanstack/react-query"
import { invalidateClassroomTeam } from "@/github-core/queries"
import { removeClassroomStaffMember } from "@/domain/students"
import { syncRosterAfterStaffChange } from "@/hooks/mutations/useAddStaffMember"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { StaffRole } from "@/types/classroom"

// Remove a staff member from a classroom's role team. Delegates to the shared
// removeClassroomStaffMember domain function (which refuses a teacher removing
// themselves — see there); the hook owns the team-members + team-invitations
// invalidation and the best-effort roster sync. Success/error toasts stay at
// the call site (see ./README.md).
export function useRemoveStaffMember(
  org: string,
  classroom: string,
  teamSlug: string,
  role: StaffRole,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (username: string) =>
      removeClassroomStaffMember(client, { org, teamSlug, username, role }),
    onSuccess: () => {
      invalidateClassroomTeam(queryClient, org, teamSlug)
      void syncRosterAfterStaffChange(client, queryClient, org, classroom)
    },
  })
}

export default useRemoveStaffMember
