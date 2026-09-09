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
// dismissed once the send is confirmed, so the fresh invitation is the only
// one on file and a failed send keeps the row's explanation.
export async function inviteMemberToOrg(
  client: GitHubClient,
  input: { org: string; row: OrgMemberRow; teamIdCache?: TeamIdCache },
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

  // Team ids for the classrooms this person is rostered on (archived ones
  // excluded: their team may be gone on purpose). Resolved through the shared
  // cache when the caller passes one (a bulk run reads each classroom.json
  // once, not once per row). A read that fails propagates, so a rate limit
  // defers the row rather than sending a team-less invite the student would
  // accept into no classroom.
  const teamIds: number[] = []
  for (const access of row.classrooms) {
    if (access.archived) continue
    const id = await resolveStudentTeamId(
      client,
      org,
      access.classroom,
      input.teamIdCache,
    )
    if (id !== undefined) teamIds.push(id)
  }

  log.info("inviting member to org", { org, inviteeId, teams: teamIds.length })
  let state: InviteToOrgResult["state"]
  try {
    const username = currentUsername ?? row.username.trim()
    if (username) {
      const result = await ensureOrgMembership(client, {
        org,
        username,
        inviteeId,
        teamIds: teamIds.length > 0 ? teamIds : undefined,
      })
      state = result.state
    } else {
      // No login to precheck with (an id-only row whose lookup failed): send
      // directly and let GitHub decide.
      await createOrgInvitation(client, {
        org,
        invitee_id: inviteeId,
        team_ids: teamIds.length > 0 ? teamIds : undefined,
      })
      state = "invited"
    }
  } catch (err) {
    throw new Error(getErrorMessage(err), { cause: err })
  }

  // The person now has a live invitation or membership on file, so the old
  // failed record is only noise. Dismissed after the send, never before: a
  // send that threw above keeps the record and the row keeps its explanation.
  if (row.failed_invitation) {
    await dismissFailedInvitation(client, {
      org,
      invitationId: row.failed_invitation.id,
    })
  }
  return { currentUsername, state }
}

// classroom path -> student team id (undefined when classroom.json names none).
export type TeamIdCache = Map<string, Promise<number | undefined>>

const resolveStudentTeamId = (
  client: GitHubClient,
  org: string,
  classroom: string,
  cache?: TeamIdCache,
): Promise<number | undefined> => {
  const cached = cache?.get(classroom)
  if (cached) return cached
  const pending = resolveTeamIdForRoleRead(client, org, classroom, "student")
  if (cache) {
    cache.set(classroom, pending)
    // A failed read must not poison the cache for the next row.
    pending.catch(() => cache.delete(classroom))
  }
  return pending
}
