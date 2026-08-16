import type { GitHubClient } from "../client"
import type { GitHubTeam, GitHubUser } from "../types"
import { GitHubAPIError, tolerateGitHubError } from "../errors"
import { createTeam } from "../teamWrites"
import { paginateAll } from "../paginate"
import {
  INVITE_TEAM_PREFIX,
  inviteTeamName,
  isInviteTeamSlug,
  marshalInviteDescription,
  parseInviteDescription,
  type InviteDescription,
  type InviteMetadata,
} from "@/util/inviteTeam"
import { logger } from "@/lib/logger"

const log = logger.scope("mutations:inviteTeams")

// Thrown by ensureInviteTeam when a pre-existing same-named team is NOT secret
// and can't be made secret. The invite team stores a plaintext email in its
// description; a closed/visible team would expose it to every org member, so we
// fail closed rather than write PII onto a team students could read.
export class InviteTeamNotSecretError extends Error {
  slug: string
  constructor(slug: string) {
    super(
      `Invite team "${slug}" is not secret; refusing to store an invited email on a team other org members could read.`,
    )
    this.name = "InviteTeamNotSecretError"
    this.slug = slug
  }
}

// `created` distinguishes a team this call freshly created from an adopted
// pre-existing one, so a caller whose org invite then fails can safely delete
// only what it created (an adopted team may hold a still-unrecovered record
// from an earlier accepted invite).
export type InviteTeamRef = { id: number; slug: string; created: boolean }

// Create (or adopt) the per-invite SECRET team for (classroom, email) and write
// the classroom50/invite/v1 record into its description. The team name is the
// deterministic invite-<hash(classroom,email)> so a later reconcile can find it
// from the roster row's email. Fail-closed on privacy: after create/adopt, the
// team's privacy is confirmed to be `secret` (an adopted non-secret team is
// PATCHed to secret; if that can't be confirmed, throw InviteTeamNotSecretError
// rather than store the email where students could read it). Returns the ref so
// the caller can attach its id to the org invitation's team_ids.
export async function ensureInviteTeam(
  client: GitHubClient,
  org: string,
  metadata: InviteMetadata,
): Promise<InviteTeamRef> {
  const name = await inviteTeamName(metadata.classroom, metadata.email)
  const description = marshalInviteDescription(metadata)

  let team: GitHubTeam
  let created = true
  try {
    team = await createTeam(client, {
      org,
      name,
      description,
      privacy: "secret",
      notification_setting: "notifications_disabled",
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 422) {
      // A same-named team already exists (a resend, a retry, or a prior invite
      // to the same email+classroom): adopt it, forcing secret + refreshing the
      // description. Name is slug-safe, so it doubles as the lookup slug.
      created = false
      team = await client.request<GitHubTeam>(
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(name)}`,
      )
    } else {
      throw err
    }
  }

  // Fail-closed secret invariant. On a fresh create GitHub honors privacy:
  // "secret", but an adopted team may be closed; PATCH it and re-read. Never
  // leave the email description on a non-secret team.
  if (team.privacy !== "secret" || team.description !== description) {
    team = await client.request<GitHubTeam>(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team.slug)}`,
      {
        method: "PATCH",
        body: { privacy: "secret", description },
      },
    )
  }
  if (team.privacy !== "secret") {
    throw new InviteTeamNotSecretError(team.slug)
  }

  return { id: team.id, slug: team.slug, created }
}

export type InviteTeamState = {
  slug: string
  description: InviteDescription | null
  // From the full-team read; null when GitHub omits it. Drives the GC age
  // guard (a team too young to judge is never reaped).
  createdAt: string | null
  // Regular-role members only (?role=member). GitHub auto-promotes the
  // creating owner — and any org owner — to team maintainer, so the invitee
  // (added via the invitation's team_ids as a plain member) is exactly what's
  // left; no org-admin subtraction needed. 404 (team vanished mid-read) yields
  // [] so the team simply looks pending; other errors propagate.
  members: GitHubUser[]
}

// Read one invite team's parsed description + members, for the reconcile pass.
// 404 (team already deleted) -> null. `description` is null when the team's
// description isn't a valid v1 record (hand-edited, or a slug collision with a
// non-invite team); the caller skips such a team rather than acting on garbage.
export async function readInviteTeam(
  client: GitHubClient,
  org: string,
  slug: string,
): Promise<InviteTeamState | null> {
  const team = await tolerateGitHubError(
    () =>
      client.request<GitHubTeam>(
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`,
      ),
    null,
  )
  if (!team) return null
  const members = await tolerateGitHubError(
    () =>
      paginateAll<GitHubUser>(
        client,
        (page) =>
          `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
            slug,
          )}/members?role=member&per_page=100&page=${page}`,
      ),
    [],
  )
  return {
    slug: team.slug,
    description: parseInviteDescription(team.description),
    createdAt: team.created_at ?? null,
    members,
  }
}

// Enumerate the org's invite-<hash> teams (secret teams this feature owns),
// filtering the org team list by the invite- prefix. STRICT: a failed listing
// throws rather than degrading to [] — the reconcile uses this list to decide
// which email-only roster rows are still backed by a live invite, and a
// degraded read must never masquerade as "no invite teams" (which would wipe
// every pending email row). Owner/member visibility still applies.
export async function listInviteTeams(
  client: GitHubClient,
  org: string,
): Promise<GitHubTeam[]> {
  const teams = await paginateAll<GitHubTeam>(
    client,
    (page) =>
      `/orgs/${encodeURIComponent(org)}/teams?per_page=100&page=${page}`,
  )
  return teams.filter((t) => t.slug && isInviteTeamSlug(t.slug))
}

// Delete an invite team by slug. Fail-closed: refuses any slug outside the
// invite- namespace so a caller can't steer a delete into an unrelated team.
// 404 = already gone (success), so teardown is idempotent.
export async function deleteInviteTeam(
  client: GitHubClient,
  org: string,
  slug: string,
): Promise<void> {
  if (!isInviteTeamSlug(slug)) {
    log.error("refusing to delete non-invite team", { slug })
    return
  }
  await tolerateGitHubError(
    () =>
      client.request(
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`,
        { method: "DELETE" },
      ),
    undefined,
  )
}

// Best-effort delete of the (classroom, email) invite team — the cancel-side
// teardown: when a teacher cancels or dismisses an email invitation, the
// stored email should go with it rather than wait for the next GC pass. Never
// throws (the cancel already succeeded; a leftover team is only a GC-pending
// orphan). Safe to call for an email with no team (404 = already gone).
export async function deleteInviteTeamForEmail(
  client: GitHubClient,
  org: string,
  input: { classroom: string; email: string },
): Promise<void> {
  try {
    const slug = await inviteTeamName(input.classroom, input.email)
    await deleteInviteTeam(client, org, slug)
  } catch (err) {
    log.error("invite team cancel-cleanup failed", { org, err })
  }
}

export { INVITE_TEAM_PREFIX }
