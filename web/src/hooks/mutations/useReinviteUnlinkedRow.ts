import { useMutation, useQueryClient } from "@tanstack/react-query"
import { reinviteUnlinkedRow } from "@/domain/students"
import { invalidateInviteQueries } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import type { ClassroomRole } from "@/util/teamRoster"

// Re-invite an unlinked email row from the roster member modal (see
// domain reinviteUnlinkedRow). Resolves to a status rather than throwing on
// "nothing sent", so the call site maps each outcome to its own copy and the
// hook stays t()-free. Invalidates on any outcome: a 422 means GitHub holds an
// invitation or member the roster hasn't seen yet, and a refetch may surface it.
export function useReinviteUnlinkedRow(org: string, classroom: string) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    meta: { keepTabOpen: true },
    mutationFn: (input: {
      email: string
      role: ClassroomRole
      failedInvitationId?: number
    }) => reinviteUnlinkedRow(client, { org, classroom, ...input }),
    onSuccess: () => invalidateInviteQueries(queryClient, org),
  })
}

export default useReinviteUnlinkedRow
