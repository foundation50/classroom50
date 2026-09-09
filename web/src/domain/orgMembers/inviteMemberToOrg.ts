import type { GitHubClient } from "@/github-core/client"
import {
  createOrgInvitation,
  ensureOrgMembership,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import { getUserById } from "@/github-core/queries"
import {
  dismissFailedInvitation,
  resolveTeamIdForRoleRead,
} from "@/domain/students"
import { isMalformedGitHubId, resolveGitHubId } from "@/util/students"
import type { OrgMemberRow } from "@/util/orgMembers"
import { logger } from "@/lib/logger"
import i18n from "@/i18n"

const log = logger.scope("orgMembers:inviteMemberToOrg")

export type InviteToOrgResult = {
  // The current GitHub login resolved from the immutable id; undefined if the
  // lookup failed (the invite is sent by id regardless).
  currentUsername?: string
  // "invited": a fresh invitation went out. "pending"/"active": GitHub already
  // had one, or the person is already a member, so nothing new was sent.
  state: "invited" | "pending" | "active"
}

// Invite a roster student who isn't (yet) an org member, the same way the
// roster does: by invitee_id (the immutable github_id, never the possibly
// stale CSV username), with every active classroom's student team attached so
// accepting the one invitation enrolls them everywhere they are rostered, and
// through ensureOrgMembership so an existing pending/active state is reported
// rather than surfacing GitHub's 422. Any failed record for the account is
// dismissed first, so the fresh invitation is the only one on file.
export async function inviteMemberToOrg(
  client: GitHubClient,
  input: { org: string; row: OrgMemberRow },
): Promise<InviteToOrgResult> {
  const { org, row } = input
  const inviteeId = resolveGitHubId(row.github_id)
  if (inviteeId === null) {
    const who = row.username || row.email
    throw new Error(
      isMalformedGitHubId(row.github_id)
        ? i18n.t("orgMembers.inviteMalformedId", {
            who,
            githubId: row.github_id.trim(),
          })
        : i18n.t("orgMembers.inviteMissingId", { who }),
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

  if (row.failed_invitation) {
    await dismissFailedInvitation(client, {
      org,
      invitationId: row.failed_invitation.id,
    })
  }

  // Team ids for the classrooms this person is rostered on (archived ones
  // excluded: their team may be gone on purpose). A classroom whose team can't
  // be resolved is skipped rather than blocking the invite; the roster's
  // sync/assign path is the backstop for that classroom.
  const teamIds: number[] = []
  for (const access of row.classrooms) {
    if (access.archived) continue
    try {
      const id = await resolveTeamIdForRoleRead(
        client,
        org,
        access.classroom,
        "student",
      )
      if (id !== undefined) teamIds.push(id)
    } catch (err) {
      log.warn("invite: classroom team unresolved, inviting without it", {
        org,
        classroom: access.classroom,
        err,
      })
    }
  }

  log.info("inviting member to org", { org, inviteeId, teams: teamIds.length })
  try {
    const username = currentUsername ?? row.username.trim()
    if (username) {
      const result = await ensureOrgMembership(client, {
        org,
        username,
        inviteeId,
        teamIds: teamIds.length > 0 ? teamIds : undefined,
      })
      return { currentUsername, state: result.state }
    }
    // No login to precheck with (an id-only row whose lookup failed): send
    // directly and let GitHub decide.
    await createOrgInvitation(client, {
      org,
      invitee_id: inviteeId,
      team_ids: teamIds.length > 0 ? teamIds : undefined,
    })
    return { currentUsername, state: "invited" }
  } catch (err) {
    throw new Error(getErrorMessage(err), { cause: err })
  }
}
