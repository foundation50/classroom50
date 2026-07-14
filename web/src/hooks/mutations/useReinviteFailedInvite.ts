import { useMutation, useQueryClient } from "@tanstack/react-query"
import { inviteRosterStudents, bulkInviteByEmail } from "@/domain/students"
import { cancelOrgInvitation } from "@/github-core/mutations"
import { invalidateInviteQueries } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { roleForOrgRole } from "@/util/teamRoster"
import type { GitHubOrgInvitation } from "@/github-core/types"

// The invite mutations bucket a rate-limited/failed target rather than throwing,
// so a caller that ignores the result would report success on a send that never
// happened. Throw a specific error unless exactly one invite actually landed
// (fresh invite or an already-active/pending skip), so a re-invite that only
// deferred/failed routes to the error path instead of a false success.
function assertInviteSent(
  res: {
    invited: unknown[]
    skipped: unknown[]
    failed: { message: string }[]
    deferred: unknown[]
  },
  messages: { rateLimited: string; notSent: string },
): void {
  const failure = res.failed[0]
  if (failure) throw new Error(failure.message)
  if (res.deferred.length > 0) throw new Error(messages.rateLimited)
  if (res.invited.length === 0 && res.skipped.length === 0)
    throw new Error(messages.notSent)
}

// Re-invite a failed/expired invitation: dismiss the dead one, then re-issue an
// equivalent fresh invite — same classroom role (instructor -> org OWNER), by
// username when known (carries the team) else by email. A login-less,
// email-less invite can't be re-issued (dismiss-only). Hook owns the
// invite-query invalidation; the error toast stays at the call site (see
// ./README.md).
export function useReinviteFailedInvite(
  org: string,
  classroom: string,
  messages: {
    noTarget: string
    // Built with `who` (login/email/id) inside the hook, so these are
    // functions the call site fills via t() — keeps the hook t()-free.
    rateLimited: (who: string) => string
    notSent: (who: string) => string
  },
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (inv: GitHubOrgInvitation) => {
      const who = inv.login || inv.email || String(inv.id)
      await cancelOrgInvitation(client, { org, invitationId: inv.id })
      const role = roleForOrgRole(inv.role)
      const sent = {
        rateLimited: messages.rateLimited(who),
        notSent: messages.notSent(who),
      }
      if (inv.login) {
        const res = await inviteRosterStudents(client, {
          org,
          classroom,
          students: [{ username: inv.login, role }],
        })
        assertInviteSent(res, sent)
      } else if (inv.email) {
        const res = await bulkInviteByEmail(client, {
          org,
          classroom,
          invites: [{ email: inv.email, role }],
        })
        assertInviteSent(res, sent)
      } else {
        throw new Error(messages.noTarget)
      }
    },
    onSuccess: () => invalidateInviteQueries(queryClient, org),
  })
}
