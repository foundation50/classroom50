import { useMutation, useQueryClient } from "@tanstack/react-query"
import { getUser, invalidateClassroomTeam } from "@/github-core/queries"
import { resendClassroomInvite } from "@/domain/students"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { ClassroomRole } from "@/authz"

// Resend a pending classroom org invitation (staff OR student). The multi-step
// data logic — resolve the invitee's immutable id (org invites don't carry it),
// then delegate to the shared resendClassroomInvite (re-attaches the role team +
// re-issues the org role). Hook owns the bound team's members + invitations
// invalidation; the toasts stay at the call site (see ./README.md). Shared by
// the Settings staff section and the roster member modal so the single-shot
// resend flow is identical across both surfaces.
//
// Hooks are t()-free: an email-only invite (no login) can't be resolved to a
// numeric invitee id, so the caller passes the pre-translated `emailOnlyMessage`
// the hook throws in that case.
export function useResendClassroomInvite(
  org: string,
  classroom: string,
  role: ClassroomRole,
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
    onSuccess: () => invalidateClassroomTeam(queryClient, org, teamSlug),
  })
}

export default useResendClassroomInvite
