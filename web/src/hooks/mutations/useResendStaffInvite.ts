import { useMutation, useQueryClient } from "@tanstack/react-query"
import { githubKeys, getUser } from "@/github-core/queries"
import { resendClassroomInvite } from "@/domain/students"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { StaffRole } from "@/types/classroom"

// Resend a pending staff org invitation. The multi-step data logic — resolve
// the invitee's immutable id (org invites don't carry it), then delegate to the
// shared resendClassroomInvite (re-attaches the role team + re-issues the org
// role). Hook owns the invitations + members invalidation for the bound team;
// the toasts stay at the call site (see ./README.md).
//
// Hooks are t()-free: an email-only invite (no login) can't be resolved to a
// numeric invitee id, so the caller passes the pre-translated `emailOnlyMessage`
// the hook throws in that case.
export function useResendStaffInvite(
  org: string,
  classroom: string,
  role: StaffRole,
  teamSlug: string,
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: {
      login: string | null
      invitationId: number
      emailOnlyMessage: string
    }) => {
      if (!input.login) throw new Error(input.emailOnlyMessage)
      const inviteeId = (await getUser(client, input.login)).id
      await resendClassroomInvite(client, {
        org,
        classroom,
        username: input.login,
        inviteeId,
        invitationId: input.invitationId,
        role,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamInvitations(org, teamSlug),
      })
      queryClient.invalidateQueries({
        queryKey: githubKeys.teamMembers(org, teamSlug),
      })
    },
  })
}

export default useResendStaffInvite
