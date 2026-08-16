import type { GitHubClient } from "@/github-core/client"
import {
  deleteInviteTeam,
  listInviteTeams,
  readInviteTeam,
} from "@/github-core/mutations"
import {
  collectInviteRecoveries,
  finalizeInviteRecoveries,
} from "./inviteBackfill"
import { syncRosterFromTeam, type SyncRosterFromTeamResult } from "./rosterSync"

export type ReconcileRosterResult = SyncRosterFromTeamResult & {
  // Invite teams deleted without a recovery (unenrolled invitee, or an aged
  // team whose org invitation is gone).
  deletedStaleTeams: number
}

// THE consolidated roster reconciliation — the single writer both the roster
// page's "Sync roster" and the owner-visit classroom reconcile call, so
// roster.csv converges in at most ONE commit per pass:
//   1. collect: classify this classroom's invite teams (accepted -> recovered
//      mappings, pending -> live emails) and GC the stale ones. No CSV writes.
//   2. sync: one conflict-retried commit that folds the recovered mappings
//      onto their rows, removes email-only rows no live invite team backs,
//      appends missing team members, and reconciles roles/ids.
//   3. finalize: delete the recovered mappings' teams only AFTER that commit
//      landed (a failed delete is re-recovered idempotently next pass).
// Throws what syncRosterFromTeam throws (archived classroom, malformed CSV,
// transient write failures); the collect half is never-throw by contract.
export async function reconcileRoster(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<ReconcileRosterResult> {
  const { org, classroom } = input
  const invites = await collectInviteRecoveries(client, { org, classroom })
  const sync = await syncRosterFromTeam(client, { org, classroom, invites })
  await finalizeInviteRecoveries(client, org, invites.recovered)
  return { ...sync, deletedStaleTeams: invites.deletedStale }
}

export type PurgeInviteTeamsResult = {
  // Emails recovered into roster.csv by the reconcile run first.
  recovered: string[]
  // Remaining invite teams for this classroom deleted afterwards.
  purged: number
}

// Teacher-triggered cleanup for the invite teams the automatic pass cannot or
// will not touch: tampered (hash-mismatched) records, multi-member anomalies,
// still-pending invites the teacher wants forgotten, and an archived
// classroom's leftovers. Runs the consolidated reconcile first so anything
// recoverable lands in roster.csv (skipped on an archived classroom, whose
// roster is frozen), then deletes EVERY remaining team whose record claims
// this classroom — the claim alone suffices here (a tamperer can at worst get
// their own team deleted). Throws on failure (an explicit action the teacher
// should see fail), except that already-gone teams read as done.
export async function purgeInviteTeams(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<PurgeInviteTeamsResult> {
  const { org, classroom } = input
  let recovered: string[] = []
  try {
    recovered = (await reconcileRoster(client, input)).recoveredEmails
  } catch {
    // Archived classroom (or an unwritable roster): recovery is off the
    // table, but purging the stored emails is exactly why the teacher is
    // here — proceed to the deletes.
  }

  let purged = 0
  const teams = await listInviteTeams(client, org)
  for (const team of teams) {
    const slug = team.slug
    if (!slug) continue
    const state = await readInviteTeam(client, org, slug)
    if (!state) continue // already gone
    if (state.description?.classroom !== classroom) continue
    await deleteInviteTeam(client, org, slug)
    purged += 1
  }
  return { recovered, purged }
}
