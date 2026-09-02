import type { GitHubClient } from "../client"
import type { GitHubTeam, GitHubUser } from "../types"
import { GitHubAPIError, tolerateGitHubError } from "../errors"
import { createTeam } from "../teamWrites"
import { removeUserFromTeam } from "./teams"
import { PAGE_FETCH_CONCURRENCY, paginateAll } from "../paginate"
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

// Thrown by ensureInviteTeam when the team still has a member after the acting
// teacher was dropped. Nobody can legitimately be on it yet (the invitation
// isn't sent until this returns), so a member is a teacher stranded by an
// earlier interrupted run — and with the role filter gone, a teacher on the team
// is exactly what the reconcile would misread as the accepted invitee. Fail
// closed BEFORE the email is written, leaving a team that holds no PII.
export class InviteTeamNotEmptyError extends Error {
  slug: string
  constructor(slug: string) {
    super(
      `Invite team "${slug}" still has a member after dropping the acting user; refusing to store an invited email on a team whose membership would be misread as the invitee.`,
    )
    this.name = "InviteTeamNotEmptyError"
    this.slug = slug
  }
}

// `created` distinguishes a team this call freshly created from an adopted
// pre-existing one, so a caller whose org invite then fails can safely delete
// only what it created (an adopted team may hold a still-unrecovered record
// from an earlier accepted invite).
export type InviteTeamRef = { id: number; slug: string; created: boolean }

// Placeholder description a team is created with, so a run that dies before the
// membership drop leaves a team holding NO email. It deliberately does not parse
// as a v1 record, which is what makes the reconcile skip such a team.
const PROVISIONAL_DESCRIPTION = "classroom50: preparing invite"

// Create (or adopt) the per-invite SECRET team for (classroom, email) and write
// the classroom50/invite/v1 record into its description. The team name is the
// deterministic invite-<hash(classroom,email)> so a later reconcile can find it
// from the roster row's email.
//
// Three fail-closed invariants, all of which throw rather than return a team
// that would leak PII or mislead the reconcile:
//   - SECRET: an adopted team is PATCHed to secret, and if that can't be
//     confirmed, InviteTeamNotSecretError — never store the email where students
//     could read it.
//   - NO TEACHER: GitHub silently adds the creator as a maintainer, and any org
//     owner it holds is auto-promoted to maintainer too, so a teacher on the team
//     is indistinguishable from an invitee who accepted. `actor` is dropped
//     unconditionally (an adopted team may carry one from an earlier run) and the
//     membership is then read back; a survivor throws InviteTeamNotEmptyError.
//     This is what lets the reconcile treat any member of any role as the
//     invitee.
//   - EMAIL LAST: the create carries only PROVISIONAL_DESCRIPTION, and the real
//     record is written only once the team is confirmed empty. GitHub adds the
//     creator during the create itself, so the drop is necessarily a second
//     request — an interrupted run (or a rate limit that throttles both the drop
//     and any compensating delete) can always strand a team with a teacher on it.
//     Ordering the email last makes that leftover harmless: it holds no address
//     and no valid record, so the reconcile skips it, and the next invite to the
//     same address adopts and heals it.
//
// Returns the ref so the caller can attach its id to the org invitation's
// team_ids.
export async function ensureInviteTeam(
  client: GitHubClient,
  org: string,
  metadata: InviteMetadata,
  actor: string,
): Promise<InviteTeamRef> {
  const name = await inviteTeamName(metadata.classroom, metadata.email)
  const description = marshalInviteDescription(metadata)

  let team: GitHubTeam
  let created = true
  try {
    team = await createTeam(client, {
      org,
      name,
      description: PROVISIONAL_DESCRIPTION,
      privacy: "secret",
      notification_setting: "notifications_disabled",
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 422) {
      // A same-named team already exists (a resend, a retry, or a prior invite
      // to the same email+classroom): adopt it, forcing secret below. Name is
      // slug-safe, so it doubles as the lookup slug.
      created = false
      team = await client.request<GitHubTeam>(
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(name)}`,
      )
    } else {
      throw err
    }
  }

  // Fail-closed secret invariant, settled BEFORE the email is written: an
  // adopted team may be closed. Never let the email description land on a
  // non-secret team.
  if (team.privacy !== "secret") {
    team = await client.request<GitHubTeam>(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team.slug)}`,
      { method: "PATCH", body: { privacy: "secret" } },
    )
  }
  if (team.privacy !== "secret") {
    throw new InviteTeamNotSecretError(team.slug)
  }

  await requireTeacherFreeTeam(client, org, team.slug, actor)

  // Only now is it safe to store the invited address.
  const withRecord = await client.request<GitHubTeam>(
    `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team.slug)}`,
    { method: "PATCH", body: { privacy: "secret", description } },
  )
  if (withRecord.privacy !== "secret") {
    throw new InviteTeamNotSecretError(withRecord.slug)
  }

  return { id: withRecord.id, slug: withRecord.slug, created }
}

// Drop `actor` from the team, then PROVE no member remains. GitHub adds the
// creator during the create, so the drop can't be atomic with it; the read-back
// is what turns the invariant from an assumption into a checked fact, and it also
// catches a DIFFERENT teacher stranded by an earlier run (whom dropping `actor`
// alone would miss). A degraded read throws rather than reading as "empty".
async function requireTeacherFreeTeam(
  client: GitHubClient,
  org: string,
  slug: string,
  actor: string,
): Promise<void> {
  await removeUserFromTeam(client, { org, teamSlug: slug, username: actor })
  const remaining = await paginateAll<GitHubUser>(
    client,
    (page) =>
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
        slug,
      )}/members?per_page=100&page=${page}`,
  )
  if (remaining.length > 0) {
    log.error("invite team still has a member after dropping the actor", {
      slug,
      remaining: remaining.length,
    })
    throw new InviteTeamNotEmptyError(slug)
  }
}

export type InviteTeamState = {
  slug: string
  description: InviteDescription | null
  // From the full-team read; null when GitHub omits it. Drives the GC age
  // guard (a team too young to judge is never reaped).
  createdAt: string | null
  // Members of EVERY role. ensureInviteTeam leaves no teacher on the team, so
  // whoever is here accepted the invitation — including an org owner, whom
  // GitHub auto-promotes to maintainer and a role=member filter would hide.
  // 404 (team vanished mid-read) yields [] so the team simply looks pending;
  // other errors propagate.
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
          )}/members?per_page=100&page=${page}`,
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

// Enumerate the org's candidate invite teams, filtering the org team list by the
// `invite-` prefix. That prefix is a namespace, not proof of ownership, so every
// caller re-checks the description for a valid v1 record before acting. STRICT:
// a failed listing throws rather than degrading to [] — the reconcile uses this
// list to decide which email-only roster rows are still backed by a live invite,
// and a degraded read must never masquerade as "no invite teams" (which would
// wipe every pending email row). Owner/member visibility still applies.
export async function listInviteTeams(
  client: GitHubClient,
  org: string,
): Promise<GitHubTeam[]> {
  const teams = await paginateAll<GitHubTeam>(
    client,
    (page) =>
      `/orgs/${encodeURIComponent(org)}/teams?per_page=100&page=${page}`,
    { concurrency: PAGE_FETCH_CONCURRENCY },
  )
  return teams.filter((t) => t.slug && isInviteTeamSlug(t.slug))
}

// Delete an invite team by slug. Refuses any slug outside the `invite-`
// namespace so a caller can't steer a delete into an unrelated team; the
// namespace alone isn't proof of ownership, so callers establish that from the
// team's v1 record first. 404 = already gone (success), so teardown is idempotent.
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

// Delete every invite team whose stored record claims `classroom`, for the
// teardown of that classroom itself. The claim is taken at face value: this path
// only ever deletes, never writes a roster row, so it doesn't need the
// reconcile's hash verification. Note the consequence — a record hand-edited to
// claim this classroom is deleted with it, which for a tampered team belonging
// to another classroom costs that classroom its email<->account mapping. The
// namespace fence in deleteInviteTeam still applies, so nothing outside the
// invite- namespace can ever be deleted.
//
// Exists because these teams are recorded nowhere in the config repo, so once a
// classroom's directory is gone nothing can find them again — the reconcile is
// classroom-scoped and its settings page (with the manual cleanup action) is
// gone too. A classroom deleted with a pending email invite would otherwise
// strand that student's address in a secret team forever.
//
// Best-effort and never throws: the caller has already committed the deletion,
// so a failure here is a leftover team to report, not a reason to fail.
// `failedSlugs` names only teams confirmed to belong to THIS classroom whose
// delete failed — safe to show a teacher as "delete by hand". A team we could
// not read is counted in `unreadable` instead: its classroom is unknown, so
// naming it could send the teacher to delete a live classroom's invite record.
// `listFailed` means the enumeration itself failed, so nothing was checked at
// all — the caller must still warn, since this is exactly the case where an
// invited email would otherwise be stranded silently.
export async function purgeClassroomInviteTeams(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<{
  purged: number
  failedSlugs: string[]
  unreadable: number
  listFailed: boolean
}> {
  const failedSlugs: string[] = []
  let purged = 0
  let unreadable = 0
  let teams: GitHubTeam[]
  try {
    teams = await listInviteTeams(client, org)
  } catch (err) {
    log.error("invite team purge: listing failed", { org, classroom, err })
    return { purged, failedSlugs, unreadable, listFailed: true }
  }

  for (const team of teams) {
    const slug = team.slug
    if (!slug) continue

    // Read and delete are separate failure classes. Until the read succeeds we
    // don't know which classroom the team belongs to, so a read failure must
    // never reach the teacher-facing slug list.
    let state: Awaited<ReturnType<typeof readInviteTeam>>
    try {
      state = await readInviteTeam(client, org, slug)
    } catch (err) {
      unreadable += 1
      log.error("invite team purge: read failed; scope unknown", {
        org,
        slug,
        err,
      })
      if (err instanceof GitHubAPIError && err.isRateLimited) break
      continue
    }
    if (!state || state.description?.classroom !== classroom) continue

    try {
      await deleteInviteTeam(client, org, slug)
      purged += 1
    } catch (err) {
      log.error("invite team purge: delete failed", { org, slug, err })
      failedSlugs.push(slug)
      // Every remaining delete would hit the same limit; stop rather than
      // hammering a throttled endpoint and reporting every team as lingering.
      if (err instanceof GitHubAPIError && err.isRateLimited) break
    }
  }
  return { purged, failedSlugs, unreadable, listFailed: false }
}
