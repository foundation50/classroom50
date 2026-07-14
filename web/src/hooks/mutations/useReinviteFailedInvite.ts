import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  inviteRosterStudents,
  bulkInviteByEmail,
} from "@/api/mutations/students"
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
export function assertInviteSent(
  res: {
    invited: unknown[]
    skipped: unknown[]
    failed: { message: string }[]
    deferred: unknown[]
  },
  who: string,
): void {
  const failure = res.failed[0]
  if (failure) throw new Error(failure.message)
  if (res.deferred.length > 0)
    throw new Error(`GitHub rate-limited the re-invite to ${who} — try again.`)
  if (res.invited.length === 0 && res.skipped.length === 0)
    throw new Error(`No invitation was sent to ${who} — try again.`)
}

// Re-invite a failed/expired invitation: dismiss the dead one, then re-issue an
// equivalent fresh invite — same classroom role (instructor -> org OWNER), by
// username when known (carries the team) else by email. A login-less,
// email-less invite can't be re-issued (dismiss-only). Per the TanStack split
// (see hooks/mutations), the hook owns only the invite-query invalidation that
// must always run; the caller passes the error toast via `mutate` so it skips
// when unmounted.
export function useReinviteFailedInvite(
  org: string,
  classroom: string,
  messages: { noTarget: string },
) {
  const client = useGitHubClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (inv: GitHubOrgInvitation) => {
      const who = inv.login || inv.email || String(inv.id)
      await cancelOrgInvitation(client, { org, invitationId: inv.id })
      const role = roleForOrgRole(inv.role)
      if (inv.login) {
        const res = await inviteRosterStudents(client, {
          org,
          classroom,
          students: [{ username: inv.login, role }],
        })
        assertInviteSent(res, who)
      } else if (inv.email) {
        const res = await bulkInviteByEmail(client, {
          org,
          classroom,
          invites: [{ email: inv.email, role }],
        })
        assertInviteSent(res, who)
      } else {
        throw new Error(messages.noTarget)
      }
    },
    onSuccess: () => invalidateInviteQueries(queryClient, org),
  })
}
