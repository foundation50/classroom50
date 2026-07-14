import type { GitHubClient } from "@/github-core/client"
import { createOrgInvitation } from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import { getUserById } from "@/github-core/queries"
import { parseGitHubId } from "@/util/students"
import type { OrgMemberRow } from "@/util/orgMembers"
import { logger } from "@/lib/logger"

const log = logger.scope("orgMembers:inviteMemberToOrg")

export type InviteToOrgResult = {
  // The current GitHub login resolved from the immutable id; undefined if the
  // lookup failed (the invite is sent by id regardless).
  currentUsername?: string
  invited: boolean
}

// Invite a roster student who isn't (yet) an org member. Sent by invitee_id (the
// immutable github_id), NOT username — the CSV username can be stale.
export async function inviteMemberToOrg(
  client: GitHubClient,
  input: { org: string; row: OrgMemberRow },
): Promise<InviteToOrgResult> {
  const { org, row } = input
  const inviteeId = parseGitHubId(row.github_id)
  if (inviteeId === null) {
    throw new Error(
      `Can't invite ${row.username || row.email}: no GitHub id on file.`,
    )
  }

  let currentUsername: string | undefined
  try {
    currentUsername = (await getUserById(client, inviteeId)).login
  } catch (err) {
    log.debug("invite: current-login lookup failed (inviting by id anyway)", {
      org,
      err,
    })
    currentUsername = undefined
  }

  log.info("inviting member to org", { org, inviteeId })
  try {
    await createOrgInvitation(client, { org, invitee_id: inviteeId })
  } catch (err) {
    throw new Error(getErrorMessage(err), { cause: err })
  }

  return { currentUsername, invited: true }
}
