import type { GitHubClient } from "../client"
import { type GitHubOrgMembership } from "../types"
import { GitHubAPIError, tolerateGitHubError } from "../errors"

// POST /orgs/{org}/invitations by invitee_id or email. An optional team_ids
// array auto-adds the invitee to those teams on acceptance, so an email invite
// can land a student directly in the classroom team without a separate
// team-add. Exactly one of invitee_id / email must be provided. Owner-only.
export function createOrgInvitation(
  client: GitHubClient,
  input: {
    org: string
    invitee_id?: number
    email?: string
    role?: "direct_member" | "admin"
    team_ids?: number[]
  },
) {
  const { org, invitee_id, email, role = "direct_member", team_ids } = input

  if (invitee_id === undefined && !email) {
    throw new Error("createOrgInvitation requires invitee_id or email")
  }

  const body: {
    role: string
    invitee_id?: number
    email?: string
    team_ids?: number[]
  } = email !== undefined ? { email, role } : { invitee_id, role }
  if (team_ids && team_ids.length > 0) {
    body.team_ids = team_ids
  }

  return client.request(`/orgs/${org}/invitations`, {
    method: "POST",
    body,
  })
}

// Owner-only. Returns { cancelled: true } when the DELETE removed a live
// invitation, or { cancelled: false } on a 404 — the invite was already gone
// (e.g. a resend replaced it, or it was cancelled elsewhere). A 404 stays
// non-throwing so resend's cancel-then-recreate and best-effort dismiss still
// proceed, but the boolean lets a caller avoid reporting a phantom cancel.
export async function cancelOrgInvitation(
  client: GitHubClient,
  input: { org: string; invitationId: number },
): Promise<{ cancelled: boolean }> {
  const { org, invitationId } = input

  return tolerateGitHubError(
    async () => {
      await client.request(`/orgs/${org}/invitations/${invitationId}`, {
        method: "DELETE",
      })
      return { cancelled: true }
    },
    { cancelled: false },
  )
}

// DELETE /orgs/{org}/memberships/{username}: removes an active member or
// cancels a pending invite. Owner-only. 404 (not affiliated) treated as success.
export async function removeOrgMembership(
  client: GitHubClient,
  input: { org: string; username: string },
): Promise<void> {
  const { org, username } = input

  await tolerateGitHubError(
    () =>
      client.request(`/orgs/${org}/memberships/${username}`, {
        method: "DELETE",
      }),
    undefined,
  )
}

export type OrgMembershipState = "active" | "pending"

// Set an EXISTING member's (or invitee's) org-level role. PUT
// /orgs/{org}/memberships/{username} with { role } — "admin" promotes to org
// owner, "member" demotes to a plain member. Used to promote an already-active
// member to owner on a confirmed teacher role change (the invite path only
// sets the role on a FRESH invite, so an existing member is never escalated
// there). Idempotent — setting the role a member already holds is a no-op PUT.
export async function setOrgMembershipRole(
  client: GitHubClient,
  input: { org: string; username: string; role: "admin" | "member" },
): Promise<void> {
  const { org, username, role } = input
  await client.request(
    `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(
      username,
    )}`,
    { method: "PUT", body: { role } },
  )
}

// PATCH /repos/{owner}/{repo} { archived: true }. Reversible and covered by the
// existing `repo` scope (unlike deletion, which needs delete_repo and a
// re-auth). The safe fallback when deletion isn't permitted. 404 = success.
export async function archiveRepo(
  client: GitHubClient,
  input: { owner: string; repo: string },
): Promise<void> {
  const { owner, repo } = input

  await tolerateGitHubError(
    () =>
      client.request(`/repos/${owner}/${repo}`, {
        method: "PATCH",
        body: { archived: true },
      }),
    undefined,
  )
}

// DELETE /repos/{owner}/{repo}. Needs the delete_repo OAuth scope. A token
// granted before delete_repo was requested (an older session) still 403s, so
// callers wanting "delete if possible, else archive" should catch the 403.
// 404 = success.
export async function deleteRepo(
  client: GitHubClient,
  input: { owner: string; repo: string },
): Promise<void> {
  const { owner, repo } = input

  await tolerateGitHubError(
    () =>
      client.request(`/repos/${owner}/${repo}`, {
        method: "DELETE",
      }),
    undefined,
  )
}

// GET /orgs/{org}/memberships/{username} -> the raw membership state. A 404
// (definitively not a member) resolves to null; ANY OTHER error propagates. The
// single low-level org-membership read every higher-level helper builds on, so
// the "404 = not a member vs. a transient blip" distinction lives in one place
// rather than being re-inlined (previously done raw in assignRosterMemberRole).
export async function readOrgMembershipState(
  client: GitHubClient,
  org: string,
  username: string,
): Promise<OrgMembershipState | null> {
  return tolerateGitHubError(async () => {
    const membership = await client.request<{ state?: OrgMembershipState }>(
      `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(
        username,
      )}`,
    )
    return membership.state ?? null
  }, null)
}

// GET /orgs/{org}/memberships/{username} -> state, or null on 404/error. The
// error-SWALLOWING form for yes/no gates that can safely treat any read failure
// as "not active" (enroll/reconcile re-checks). A caller that must tell a
// definitive non-member apart from a transient error (to avoid misrouting the
// teacher) uses readOrgMembershipState, which rethrows non-404s.
export async function getOrgMembershipState(
  client: GitHubClient,
  org: string,
  username: string,
): Promise<OrgMembershipState | null> {
  try {
    return await readOrgMembershipState(client, org, username)
  } catch {
    return null
  }
}

// Error-safe "is this login an active org member?" — the boolean form of the
// membership re-check used across the enroll/reconcile paths. A missing username
// or any read failure resolves to false (never throws), so a yes/no-gate caller
// needn't re-inline the getOrgMembershipState === "active" + try/catch dance. A
// caller that must surface a tailored error on a non-member calls
// getOrgMembershipState directly to throw its own message.
export async function isActiveMember(
  client: GitHubClient,
  org: string,
  username: string,
): Promise<boolean> {
  if (!username.trim()) return false
  return (await getOrgMembershipState(client, org, username)) === "active"
}

type EnsureOrgMembershipResult = {
  // "active"/"pending" = no new invite sent; "invited" = a fresh one created.
  state: OrgMembershipState | "invited"
}

// Precheck membership, invite only when neither active nor pending, and treat a
// 422 (already member/invited) as success via a follow-up read. Optional
// teamIds attach to a fresh invite so accepting the single org invitation
// activates team membership atomically (no separate team invite that could
// leave the student org-active but team-pending).
export async function ensureOrgMembership(
  client: GitHubClient,
  input: {
    org: string
    username: string
    inviteeId: number
    teamIds?: number[]
    // Org-level role for a FRESH invite: "admin" makes the invitee an org owner
    // (used for a teacher invite), else a plain member. Ignored when the
    // person is already active/pending (we don't escalate an existing member).
    role?: "direct_member" | "admin"
  },
): Promise<EnsureOrgMembershipResult> {
  const { org, username, inviteeId, teamIds, role = "direct_member" } = input

  const existing = await getOrgMembershipState(client, org, username)
  if (existing === "active" || existing === "pending") {
    return { state: existing }
  }

  try {
    await createOrgInvitation(client, {
      org,
      invitee_id: inviteeId,
      team_ids: teamIds,
      role,
    })
    return { state: "invited" }
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 422) {
      const state = await getOrgMembershipState(client, org, username)
      if (state === "active" || state === "pending") {
        return { state }
      }
    }
    throw err
  }
}

// Resend an org invite without ever leaving the student invite-less, re-issuing
// an invite EQUIVALENT to the original — same org role and same team(s), so a
// resend never changes what the invitee accepts into. A fresh
// `ensureOrgMembership` recreates when the invitee is neither active nor
// pending. When they ARE still pending and we know the stale invitation id,
// cancel it and recreate so the invite is genuinely re-sent (previously this
// short-circuited on the pending precheck and re-sent nothing). GitHub blocks a
// second invite while one is pending, so the stale invite MUST be cancelled
// before the recreate — which opens a window where a failed recreate would
// leave the invitee with no invitation at all. To close it, a failed recreate
// best-effort re-issues the original invite before rethrowing, so a transient
// error (429/5xx) restores the pending state instead of orphaning the invitee.
// If the recreate 422s (a pending invite still blocks it), that existing invite
// is the live one, so leave it in place.
export async function resendOrgInvitation(
  client: GitHubClient,
  input: {
    org: string
    username: string
    inviteeId: number
    invitationId?: number
    // Team ids to re-attach to the recreated invite so accepting it lands the
    // invitee on the classroom/staff team. Without this a re-sent invite is
    // recreated team-less and the accepted invitee is orphaned (uncollected).
    teamIds?: number[]
    // Org role to re-issue with so the resend matches the original invite: an
    // teacher invite is "admin" (org OWNER), everyone else "direct_member".
    // Omitted defaults to direct_member — a caller resending a teacher must
    // pass "admin" or the re-sent invite would silently downgrade to a member.
    role?: "direct_member" | "admin"
  },
): Promise<EnsureOrgMembershipResult> {
  const { org, username, inviteeId, invitationId, teamIds, role } = input

  const result = await ensureOrgMembership(client, {
    org,
    username,
    inviteeId,
    teamIds,
    role,
  })

  if (result.state === "invited") {
    // A fresh invite was created; cancel the prior one if we know it.
    if (invitationId !== undefined) {
      await cancelOrgInvitation(client, { org, invitationId })
    }
    return result
  }

  // Still pending with a known stale invite: cancel it and recreate so the
  // student actually receives a new invitation. Active members are left alone.
  if (result.state === "pending" && invitationId !== undefined) {
    await cancelOrgInvitation(client, { org, invitationId })
    try {
      return await ensureOrgMembership(client, {
        org,
        username,
        inviteeId,
        teamIds,
        role,
      })
    } catch (err) {
      // Best-effort re-issue (see the orphan-window note above), then rethrow.
      try {
        await createOrgInvitation(client, {
          org,
          invitee_id: inviteeId,
          team_ids: teamIds,
          role,
        })
      } catch {
        // Compensation itself failed — nothing more to do; the original error
        // (below) is the one the caller acts on.
      }
      throw err
    }
  }

  return result
}

export async function getPendingOrgInvite(client: GitHubClient, org: string) {
  return client.request<GitHubOrgMembership>(`/user/memberships/orgs/${org}`)
}
