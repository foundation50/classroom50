import { useMutation, useQueryClient } from "@tanstack/react-query"
import { reinviteEmailRow } from "@/domain/students"
import { invalidateInviteQueries } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { ClassroomRole } from "@/util/teamRoster"

// Send a fresh invitation to one email row from the roster member modal: a
// pending email-only row (resend) or an unlinked one (re-invite). Resolves to a
// status rather than throwing on "nothing sent", so the call site maps each
// outcome to its own copy and the hook stays t()-free. Invalidates on every
// outcome: a 422 means GitHub holds an invitation or member the roster hasn't
// seen yet, and a thrown failure may still have cancelled or restored writes.
export function useReinviteEmailRow(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: (input: {
      email: string
      role: ClassroomRole
      pendingInvitationId?: number
      failedInvitationId?: number
    }) => reinviteEmailRow(client, { org, classroom, ...input }),
    onSettled: () => invalidateInviteQueries(queryClient, org),
  })
}

export default useReinviteEmailRow
