import type { GitHubClient } from "@/github-core/client"
import { deleteInviteTeamForEmail } from "@/github-core/mutations"
import { removeEmailInviteRow } from "./rosterPrimitives"

// Everything an email invitation leaves behind, cleared in one call: the secret
// invite team holding the address, and the pending roster.csv row.
//
// One helper because four call sites need this after cancelling or dismissing an
// invitation (the two invite hooks, the roster member modal, the bulk actions
// bar), and a hand-synced copy in each is how one of them silently stops doing
// half the job. Callers pass the address they cancelled; a username invitation
// has neither artifact, so callers skip this entirely for those.
//
// Never throws — both steps are best-effort by design. The cancellation itself
// has already succeeded, so a leftover team (GC reaps it) or a leftover row (the
// reconcile reaps it) must not be reported to the teacher as a failed cancel.
export async function retireEmailInvite(
  client: GitHubClient,
  input: { org: string; classroom: string; email: string },
): Promise<void> {
  const { org, classroom, email } = input
  await deleteInviteTeamForEmail(client, org, { classroom, email })
  await removeEmailInviteRow(client, { org, classroom }, email)
}
