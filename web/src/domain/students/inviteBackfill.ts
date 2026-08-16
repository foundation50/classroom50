import type { GitHubClient } from "@/github-core/client"
import {
  deleteInviteTeam,
  listInviteTeams,
  readInviteTeam,
} from "@/github-core/mutations"
import { listOrgInvitations, listTeamMembers } from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { inviteTeamName } from "@/util/inviteTeam"
import { classroomTeamSlugs } from "@/util/teamSlug"
import { log } from "./rosterPrimitives"

// One accepted invite whose email <-> account mapping was recovered from its
// metadata team. The roster sync folds it into roster.csv; the team at `slug`
// is deleted only AFTER that commit lands (push-before-delete).
export type RecoveredInvite = {
  email: string
  invitee: { id: number; login: string }
  slug: string
}

export type InviteReconcileState = {
  recovered: RecoveredInvite[]
  // Normalized emails whose invite team is still live (invite pending, or an
  // anomaly we refuse to touch). An email-only roster row backed by one of
  // these must be KEPT by the sync's removal pass.
  liveInviteEmails: Set<string>
  // True only when the invite-team enumeration AND every per-team read
  // completed. When false the sync must not remove email-only rows — an
  // unreadable team can't prove its row is dead.
  trusted: boolean
  // Teams deleted without a recovery: an accepted invitee no longer on any
  // classroom team (unenrolled — must not resurrect a row), or a member-less
  // team whose org invitation is gone (cancelled/expired) aged past the GC
  // guard.
  deletedStale: number
}

const emptyState = (): InviteReconcileState => ({
  recovered: [],
  liveInviteEmails: new Set(),
  trusted: false,
  deletedStale: 0,
})

// A member-less invite team is only GC'd once it's older than this, so a team
// created moments before its org invitation lands (or read mid-creation) can
// never be reaped by a racing reconcile. Cancelled invites are usually torn
// down immediately by the cancel path; this pass is the backstop.
const INVITE_TEAM_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000

// Read-only-on-CSV half of the invite reconcile: enumerate this classroom's
// invite-<hash> teams and classify each one, WITHOUT writing roster.csv (the
// roster sync folds the result into its single commit). For each team that
// belongs to THIS classroom (by its validated description):
//   - verify the description's email hashes back to the team name (the team is
//     invitee-editable after acceptance, so this is the trust boundary);
//   - with exactly one regular-role member (GitHub keeps org owners as team
//     maintainers, so role=member is the accepted-invitee set) who is still on
//     a classroom team -> a RECOVERED mapping. The team is left in place for
//     the caller to delete after the roster commit lands;
//   - one member on NO classroom team -> unenrolled after accepting; delete the
//     team now so the mapping can't resurrect a removed student;
//   - zero members -> the invite is live (row kept), unless the team aged past
//     the GC guard AND no pending org invitation still maps to it (cancelled/
//     expired) -> delete;
//   - anomalies (tampered hash, >1 member) -> keep the team, count its email
//     as live, and warn — never guess.
//
// Never throws. Fail-safe: any read failure (enumeration, a team, the org
// invitation list) flips `trusted` off so the sync skips row removals; a rate
// limit stops the pass early the same way.
export async function collectInviteRecoveries(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<InviteReconcileState> {
  const { org, classroom } = input
  const recovered: RecoveredInvite[] = []
  const liveInviteEmails = new Set<string>()
  let trusted = true
  let deletedStale = 0

  let inviteTeams
  try {
    inviteTeams = await listInviteTeams(client, org)
  } catch (err) {
    log.error("invite reconcile: team listing failed", { org, err })
    return emptyState()
  }

  // The invitee must still be on a classroom team (student or staff) for a
  // recovery to count; fetched lazily once. A read failure propagates to the
  // per-team catch, never silently reads as "member of nothing".
  let enrolledIds: Set<number> | null = null
  const loadEnrolledIds = async (): Promise<Set<number>> => {
    if (enrolledIds) return enrolledIds
    const rosters = await Promise.all(
      classroomTeamSlugs(classroom).map((slug) =>
        listTeamMembers(client, org, slug),
      ),
    )
    enrolledIds = new Set(rosters.flat().map((m) => m.id))
    return enrolledIds
  }

  // Live invite-team slugs derived by hashing every pending email invitation's
  // address; fetched lazily, only when a member-less team is old enough to be
  // a GC candidate. NOT error-tolerated — a degraded read propagates (skip).
  let liveInviteSlugs: Set<string> | null = null
  const loadLiveInviteSlugs = async (): Promise<Set<string>> => {
    if (liveInviteSlugs) return liveInviteSlugs
    const pending = await listOrgInvitations(client, org)
    const slugs = await Promise.all(
      pending
        .filter((inv) => !inv.login && inv.email)
        .map((inv) => inviteTeamName(classroom, inv.email as string)),
    )
    liveInviteSlugs = new Set(slugs)
    return liveInviteSlugs
  }

  for (const team of inviteTeams) {
    const slug = team.slug
    if (!slug) continue
    try {
      const state = await readInviteTeam(client, org, slug)
      if (!state) continue // already deleted
      const record = state.description
      // Not a valid v1 record, or belongs to another classroom — leave it for
      // that classroom's own reconcile (or manual cleanup); never touch it.
      if (!record || record.classroom !== classroom) continue

      // Trust boundary: only act on a description whose recorded email still
      // hashes back to this team's name. A tampered team is kept (and its
      // email treated as live) rather than acted on.
      const expected = await inviteTeamName(classroom, record.email)
      if (expected !== slug) {
        log.error("invite team email does not match its name hash; skipping", {
          slug,
        })
        liveInviteEmails.add(record.email)
        continue
      }

      const invitees = state.members
      if (invitees.length === 0) {
        // Pending — or abandoned. Reap only when BOTH hold: old enough that a
        // mid-creation race is impossible, and no pending org invitation still
        // maps to this slug. Uncertainty always keeps the team (and the row).
        if (
          isPastGcAge(state.createdAt) &&
          !(await loadLiveInviteSlugs()).has(slug)
        ) {
          await deleteInviteTeam(client, org, slug)
          deletedStale += 1
        } else {
          liveInviteEmails.add(record.email)
        }
        continue
      }
      if (invitees.length > 1) {
        log.error("invite team has multiple regular members; skipping", {
          slug,
          count: invitees.length,
        })
        liveInviteEmails.add(record.email)
        continue
      }

      const invitee = invitees[0]
      if (!(await loadEnrolledIds()).has(invitee.id)) {
        // Accepted, then removed from the classroom: the invite lifecycle is
        // over. Delete the team so its record can't resurrect the row later.
        await deleteInviteTeam(client, org, slug)
        deletedStale += 1
        continue
      }

      recovered.push({
        email: record.email,
        invitee: { id: invitee.id, login: invitee.login },
        slug,
      })
    } catch (err) {
      // An unreadable team can't prove its row is dead — removals are off for
      // this pass either way.
      trusted = false
      if (err instanceof GitHubAPIError && err.isRateLimited) {
        log.error("invite reconcile rate-limited; stopping pass", { slug })
        break
      }
      log.error("invite reconcile failed for team", { slug, err })
    }
  }

  return { recovered, liveInviteEmails, trusted, deletedStale }
}

// Post-commit teardown: delete each recovered mapping's invite team, AFTER the
// roster commit folding it has landed (a failed delete just means the next
// pass re-recovers idempotently). Best-effort; never throws.
export async function finalizeInviteRecoveries(
  client: GitHubClient,
  org: string,
  recovered: RecoveredInvite[],
): Promise<void> {
  for (const r of recovered) {
    try {
      await deleteInviteTeam(client, org, r.slug)
    } catch (err) {
      log.error("invite team post-commit delete failed", { slug: r.slug, err })
    }
  }
}

// Whether a team's created_at is older than the GC age guard. Unparseable or
// missing timestamps read as "not old enough" — never reap on uncertainty.
function isPastGcAge(createdAt: string | null): boolean {
  if (!createdAt) return false
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return false
  return Date.now() - created > INVITE_TEAM_GC_MIN_AGE_MS
}
