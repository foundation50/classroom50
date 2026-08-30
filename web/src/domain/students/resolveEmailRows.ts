// Resolve uploaded email addresses to GitHub accounts via the classroom
// identity directory, so a returning student is enrolled directly instead of
// re-invited. Directory hits are only leads: each one is re-verified at
// decision time (current login by immutable id, active org membership) before
// it may become a link.

import type { GitHubClient } from "@/github-core/client"
import { readOrgMembershipState } from "@/github-core/mutations"
import { getUserById } from "@/github-core/queries"
import { normalizeInviteEmail } from "@/util/inviteTeam"
import { buildIdentityDirectory } from "./identityDirectory"

export type ResolvedEmailLink = {
  email: string
  id: number
  // The CURRENT login (re-resolved by id), never the directory's stored cell.
  login: string
  // The classroom whose roster recorded the mapping, for the preview/result copy.
  classroom: string
}

// Never throws; an address that can't be verified simply doesn't appear in
// `links` (it falls back to the ordinary email-invite path). `degraded` mirrors
// the directory: some classrooms couldn't be read, so more addresses may have
// been linkable than reported.
export async function resolveEmailRows(
  client: GitHubClient,
  org: string,
  emails: string[],
): Promise<{ links: ResolvedEmailLink[]; degraded: boolean }> {
  const unique = [...new Set(emails.map(normalizeInviteEmail).filter(Boolean))]
  // The directory build walks every classroom, so never pay for it on an
  // upload that carries no addresses.
  if (unique.length === 0) return { links: [], degraded: false }

  const directory = await buildIdentityDirectory(client, org)
  const links: ResolvedEmailLink[] = []
  // Sequential on purpose: a file carries a handful of addresses at most, and
  // each verification is two small reads.
  for (const email of unique) {
    const identity = directory.byEmail.get(email)
    if (!identity || identity === "ambiguous") continue
    let login: string
    try {
      login = (await getUserById(client, identity.id)).login
    } catch {
      // A 404 (deleted account) or any read failure means we can't vouch for
      // the link — fall back to inviting the address.
      continue
    }
    let state: Awaited<ReturnType<typeof readOrgMembershipState>>
    try {
      state = await readOrgMembershipState(client, org, login)
    } catch {
      continue
    }
    if (state !== "active") continue
    links.push({ email, id: identity.id, login, classroom: identity.classroom })
  }
  return { links, degraded: directory.degraded }
}
