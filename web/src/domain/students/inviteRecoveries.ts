import type { GitHubClient } from "@/github-core/client"
import {
  deleteInviteTeam,
  listInviteTeams,
  readInviteTeam,
} from "@/github-core/mutations"
import {
  getTeamMembershipState,
  listOrgInvitations,
  listTeamMembers,
} from "@/github-core/queries"
import { GitHubAPIError } from "@/github-core/errors"
import { inviteTeamName, normalizeInviteEmail } from "@/util/inviteTeam"
import { log, resolveClassroomTeamSlugs } from "./rosterPrimitives"

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
//
// Exported to be pinned: the teacher CLI reconciles the same teams and mirrors
// this gate as contract.InviteTeamGCMinAge with NO compile-time link, so a
// one-sided shortening would let one tool reap invites the other just created.
export const INVITE_TEAM_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000

// How many invite teams the collect pass classifies at once. High enough to
// take a large classroom's pass from minutes to seconds, low enough to stay
// clear of GitHub's secondary (concurrency-sensitive) rate limits.
const INVITE_TEAM_READ_CONCURRENCY = 5

// Read-only-on-CSV half of the invite reconcile: enumerate this classroom's
// invite-<hash> teams and classify each one, WITHOUT writing roster.csv (the
// roster sync folds the result into its single commit). A team whose slug a
// pending org invitation still maps to is counted live from the invitation
// alone — no per-team read (#800). For each remaining team that belongs to
// THIS classroom (by its validated description):
//   - verify the description's email hashes back to the team name (the team is
//     invitee-editable after acceptance, so this is the trust boundary);
//   - with exactly one member (of any role — the team holds no teacher, so
//     whoever is on it accepted, including an org owner GitHub auto-promoted to
//     maintainer) who is still on a classroom team -> a RECOVERED mapping. The
//     team is left in place for the caller to delete after the roster commit
//     lands;
//   - one member on NO classroom team -> unenrolled after accepting; delete the
//     team now so the mapping can't resurrect a removed student. Absence is
//     re-proven at decision time first (see confirmEnrollment);
//   - zero members -> the invite is live (row kept), unless the team aged past
//     the GC guard AND no pending org invitation still maps to it (cancelled/
//     expired) -> delete;
//   - anomalies (tampered hash, >1 member) -> keep the team, count its email
//     as live, and warn — never guess.
//
// `readOnly` classifies WITHOUT the deletes (stale/unenrolled teams are simply
// not counted live): the roster sync's in-closure re-collect runs on every
// conflict-retry attempt and from plain team syncs, and an irreversible
// destructive action does not belong inside either. Deletion stays exclusive
// to the top-level reconcile's own collect pass.
//
// Never throws. Fail-safe: any read failure (enumeration, a team, the org
// invitation list) flips `trusted` off so the sync skips row removals; a rate
// limit stops the pass early the same way (workers stop pulling teams, and
// what was already in flight finishes). Non-skipped teams are classified by a
// small concurrent pool — their reads are independent, and running them
// serially dominated large classrooms' sync time.
export async function collectInviteRecoveries(
  client: GitHubClient,
  input: { org: string; classroom: string; readOnly?: boolean },
): Promise<InviteReconcileState> {
  const { org, classroom, readOnly = false } = input
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

  // Pending org invitations read ONCE, up front, each address hashed to its
  // deterministic team slug — so the loop can classify a still-pending team as
  // live WITHOUT reading it: an outstanding org invitation proves nobody
  // accepted, so the team holds no email↔account mapping to recover (#800).
  // The address comes from GitHub's invitation record — stronger than the
  // invitee-editable description — but it does mean a tampered description on
  // a skipped team goes unlogged this pass; it is caught as soon as the
  // invitation resolves and the team is read. Null after a failed read: the
  // GC reap is off (uncertainty never reaps) and the loop falls back to
  // reading every team the long way, with `trusted` already cleared so no row
  // is removed either. Skipped entirely with no teams to classify, so a broken
  // invitations endpoint can't degrade a pass with nothing to prove.
  let pendingBySlug: Map<string, string> | null = null
  if (inviteTeams.length > 0) {
    try {
      const pending = await listOrgInvitations(client, org)
      pendingBySlug = new Map(
        await Promise.all(
          pending
            .filter((inv) => !inv.login && inv.email)
            .map(async (inv) => {
              const email = normalizeInviteEmail(inv.email as string)
              return [await inviteTeamName(classroom, email), email] as const
            }),
        ),
      )
    } catch (err) {
      trusted = false
      log.error("invite reconcile: pending invitation read failed", {
        org,
        err,
      })
    }
  }

  // The invitee must still be on a classroom team (student or staff) for a
  // recovery to count; fetched lazily once. Reads the AUTHORITATIVE slugs from
  // classroom.json (GitHub can rewrite a team slug on name collision, so a
  // derived slug would 404 -> [] and make an enrolled invitee look unenrolled).
  // A read failure propagates to the per-team catch, never silently reads as
  // "member of nothing". The PROMISE is memoized so concurrent team
  // classifications share one in-flight read; a rejection clears the slot so
  // one transient failure doesn't poison every later team.
  let classroomSlugsPromise: ReturnType<
    typeof resolveClassroomTeamSlugs
  > | null = null
  const loadClassroomSlugs = () => {
    classroomSlugsPromise ??= resolveClassroomTeamSlugs(
      client,
      org,
      classroom,
    ).catch((err: unknown) => {
      classroomSlugsPromise = null
      throw err
    })
    return classroomSlugsPromise
  }
  let enrolledIdsPromise: Promise<Set<number>> | null = null
  const loadEnrolledIds = (): Promise<Set<number>> => {
    enrolledIdsPromise ??= (async () => {
      const slugs = await loadClassroomSlugs()
      const rosters = await Promise.all(
        [slugs.student, ...Object.values(slugs.staff)].map((slug) =>
          listTeamMembers(client, org, slug),
        ),
      )
      return new Set(rosters.flat().map((m) => m.id))
    })().catch((err: unknown) => {
      enrolledIdsPromise = null
      throw err
    })
    return enrolledIdsPromise
  }

  // Decision-time proof for the ONE irreversible action in this pass: is this
  // login on any classroom team RIGHT NOW? The cached snapshot above predates
  // most of the loop, so a student who accepts while it iterates is absent
  // from it while already sitting on their invite team — deleting on that
  // stale evidence destroys the only record of their email <-> account mapping
  // (issue #756). Point reads, not a re-list: the snapshot lists are exactly
  // what went stale. "unknown" (a failed read) must keep the team.
  const confirmEnrollment = async (
    login: string,
  ): Promise<"enrolled" | "unenrolled" | "unknown"> => {
    try {
      const slugs = await loadClassroomSlugs()
      for (const slug of [slugs.student, ...Object.values(slugs.staff)]) {
        const state = await getTeamMembershipState(client, org, slug, login)
        if (state !== null) return "enrolled"
      }
      return "unenrolled"
    } catch (err) {
      // A rate limit must stop the whole pass (the per-team catch below
      // handles it), not read as one team's "unknown".
      if (err instanceof GitHubAPIError && err.isRateLimited) throw err
      log.error("invite reconcile: enrollment re-check failed", { login, err })
      return "unknown"
    }
  }

  // One team's classification, isolated so a bounded pool can run several at
  // once. Never throws; every shared-state effect is carried in the returned
  // outcome (except `enrolled`, whose mid-pass add only ever widens the set)
  // so the caller can fold outcomes in team order and keep `recovered`
  // deterministic.
  type TeamOutcome =
    | { kind: "none" }
    | { kind: "live"; email: string }
    | { kind: "recovered"; value: RecoveredInvite }
    | { kind: "deletedStale" }
    | { kind: "untrusted" }
    | { kind: "rateLimited" }
  const classifyTeam = async (slug: string): Promise<TeamOutcome> => {
    try {
      const state = await readInviteTeam(client, org, slug)
      if (!state) return { kind: "none" } // already deleted
      const record = state.description
      // Not a valid v1 record, or belongs to another classroom — leave it for
      // that classroom's own reconcile (or manual cleanup); never touch it.
      if (!record || record.classroom !== classroom) return { kind: "none" }

      // Trust boundary: only act on a description whose recorded email still
      // hashes back to this team's name. A tampered team is kept (and its
      // email treated as live) rather than acted on.
      const expected = await inviteTeamName(classroom, record.email)
      if (expected !== slug) {
        log.error("invite team email does not match its name hash; skipping", {
          slug,
        })
        return { kind: "live", email: record.email }
      }

      const invitees = state.members
      if (invitees.length === 0) {
        // Pending — or abandoned. Reap only when ALL hold: the invitation
        // list was readable (a null map is uncertainty, and uncertainty
        // always keeps the team and the row), old enough that a mid-creation
        // race is impossible, and no pending invitation still maps to this
        // slug (already ruled out by the loop-top skip; re-checked here so
        // the reap never rests on that ordering).
        if (
          pendingBySlug !== null &&
          isPastGcAge(state.createdAt) &&
          !pendingBySlug.has(slug)
        ) {
          if (!readOnly) {
            await deleteInviteTeam(client, org, slug)
            return { kind: "deletedStale" }
          }
          return { kind: "none" }
        }
        return { kind: "live", email: record.email }
      }
      if (invitees.length > 1) {
        log.error("invite team has multiple members; skipping", {
          slug,
          count: invitees.length,
        })
        return { kind: "live", email: record.email }
      }

      const invitee = invitees[0]
      const enrolled = await loadEnrolledIds()
      if (enrolled.size === 0) {
        // This member accepted an invite carrying a classroom team, so a
        // classroom with zero visible members means the read was degraded, not
        // that they were unenrolled. Can't prove either state: keep the team.
        log.error("invite reconcile: no classroom members visible; skipping", {
          slug,
        })
        return { kind: "untrusted" }
      }
      if (!enrolled.has(invitee.id)) {
        // Absent from the snapshot is NOT proof of unenrollment (see
        // confirmEnrollment); a confirmed stale snapshot means they enrolled
        // mid-pass, so recover them.
        const confirmed = await confirmEnrollment(invitee.login)
        if (confirmed === "unknown") return { kind: "untrusted" }
        if (confirmed === "unenrolled") {
          // Accepted, then removed from the classroom: the invite lifecycle is
          // over. Delete the team so its record can't resurrect the row later.
          if (!readOnly) {
            await deleteInviteTeam(client, org, slug)
            return { kind: "deletedStale" }
          }
          return { kind: "none" }
        }
        enrolled.add(invitee.id)
      }

      return {
        kind: "recovered",
        value: {
          email: record.email,
          invitee: { id: invitee.id, login: invitee.login },
          slug,
        },
      }
    } catch (err) {
      // An unreadable team can't prove its row is dead — removals are off for
      // this pass either way.
      if (err instanceof GitHubAPIError && err.isRateLimited) {
        log.error("invite reconcile rate-limited; stopping pass", { slug })
        return { kind: "rateLimited" }
      }
      log.error("invite reconcile failed for team", { slug, err })
      return { kind: "untrusted" }
    }
  }

  // Teams still needing a read, after the invitation-list skip above.
  const toRead: string[] = []
  for (const team of inviteTeams) {
    const slug = team.slug
    if (!slug) continue
    const pendingEmail = pendingBySlug?.get(slug)
    if (pendingEmail !== undefined) {
      // This slug can only be the hash of a pending address for THIS
      // classroom (another classroom's hash never collides into it), so the
      // invitation itself proves the invite is live and unaccepted: no team
      // read, no members read.
      liveInviteEmails.add(pendingEmail)
      continue
    }
    toRead.push(slug)
  }

  // Bounded worker pool: the per-team reads dominated large classrooms when
  // run serially, and they are independent. A rate limit stops workers from
  // PULLING further teams (in-flight classifications finish) — the parallel
  // equivalent of the old serial break. Outcomes fold in team order below so
  // `recovered` stays deterministic regardless of completion order.
  const outcomes = new Array<TeamOutcome | undefined>(toRead.length)
  let nextIndex = 0
  let rateLimited = false
  const worker = async () => {
    while (!rateLimited) {
      const i = nextIndex++
      if (i >= toRead.length) return
      const outcome = await classifyTeam(toRead[i])
      outcomes[i] = outcome
      if (outcome.kind === "rateLimited") rateLimited = true
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(INVITE_TEAM_READ_CONCURRENCY, toRead.length) },
      worker,
    ),
  )

  for (const outcome of outcomes) {
    // A slot never scheduled (pool stopped on a rate limit): the unread team
    // can't prove anything, which `trusted` — already cleared by the
    // rateLimited outcome that stopped the pool — accounts for.
    if (!outcome) continue
    switch (outcome.kind) {
      case "live":
        liveInviteEmails.add(outcome.email)
        break
      case "recovered":
        recovered.push(outcome.value)
        break
      case "deletedStale":
        deletedStale += 1
        break
      case "untrusted":
      case "rateLimited":
        trusted = false
        break
      case "none":
        break
    }
  }

  return { recovered, liveInviteEmails, trusted, deletedStale }
}

// Post-commit teardown: delete each recovered mapping's invite team, AFTER the
// roster commit folding it has landed (a failed delete just means the next
// pass re-recovers idempotently). Best-effort; never throws.
//
// Skips any slug a pending invitation now maps to: the slug is a deterministic
// hash, so a same-email RE-INVITE in the window since collect adopts this very
// team, and deleting it would tear the metadata team off a brand-new live
// invitation. An unreadable invitation list keeps every team — a leftover is
// re-recovered next pass, whereas a wrong delete loses the email for good.
export async function finalizeInviteRecoveries(
  client: GitHubClient,
  input: { org: string; classroom: string },
  recovered: RecoveredInvite[],
): Promise<void> {
  if (recovered.length === 0) return
  const { org, classroom } = input

  let live: Set<string>
  try {
    live = await liveInviteSlugsFor(client, org, classroom)
  } catch (err) {
    log.error("invite teardown: liveness read failed; keeping teams", {
      org,
      err,
    })
    return
  }

  for (const r of recovered) {
    if (live.has(r.slug)) continue
    try {
      await deleteInviteTeam(client, org, r.slug)
    } catch (err) {
      log.error("invite team post-commit delete failed", { slug: r.slug, err })
    }
  }
}

// Emails with a still-pending EMAIL invitation, normalized for roster-row
// comparison. The liveness signal the sync's dead-row removal confirms against
// at commit time: collect's team snapshot is taken BEFORE the sync reads
// roster.csv, so an invite sent in between has a row but no snapshot entry.
// Returns null when the read fails, so a caller can fail closed rather than
// reap rows on a blind guess.
export async function pendingInviteEmails(
  client: GitHubClient,
  org: string,
): Promise<Set<string> | null> {
  try {
    const pending = await listOrgInvitations(client, org)
    return new Set(
      pending
        .filter((inv) => !inv.login && inv.email)
        .map((inv) => normalizeInviteEmail(inv.email as string)),
    )
  } catch (err) {
    log.error("pending invitation read failed; keeping email rows", {
      org,
      err,
    })
    return null
  }
}

// Invite-team slugs a pending EMAIL invitation still maps to. Hashing each
// pending address reproduces its team's slug, so this is the liveness signal
// both the GC guard and the post-commit teardown consult. Strict: a failed read
// propagates so a caller fails closed rather than reading as "nothing is live".
async function liveInviteSlugsFor(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<Set<string>> {
  const pending = await listOrgInvitations(client, org)
  const slugs = await Promise.all(
    pending
      .filter((inv) => !inv.login && inv.email)
      .map((inv) => inviteTeamName(classroom, inv.email as string)),
  )
  return new Set(slugs)
}

// Whether a team's created_at is older than the GC age guard. Unparseable or
// missing timestamps read as "not old enough" — never reap on uncertainty.
function isPastGcAge(createdAt: string | null): boolean {
  if (!createdAt) return false
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return false
  return Date.now() - created > INVITE_TEAM_GC_MIN_AGE_MS
}
