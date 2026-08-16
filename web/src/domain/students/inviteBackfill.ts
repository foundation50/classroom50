import type { GitHubClient } from "@/github-core/client"
import {
  deleteInviteTeam,
  listInviteTeams,
  readInviteTeam,
} from "@/github-core/mutations"
import { listOrgAdmins } from "@/github-core/queries"
import { inviteTeamName, type InviteDescription } from "@/util/inviteTeam"
import { normalizeStudentRow, type StudentCsvRow } from "@/util/rosterCsv"
import { parseGitHubId } from "@/util/identity"
import { withRosterRewrite, log } from "./rosterPrimitives"

export type BackfillInviteMetadataResult = {
  // Emails whose invite team was reconciled into roster.csv and then deleted.
  backfilled: string[]
  // Invite teams deleted without a backfill (stale: no accepted member and the
  // team's classroom matches — a cancelled/expired invite left the team behind).
  // Not currently distinguished from backfilled at the call site; kept for logs.
  deletedStale: number
}

// Recover the invited-email <-> GitHub-account mapping that only the per-invite
// metadata teams retain, and fold it into roster.csv. For each invite-<hash>
// team in the org that belongs to THIS classroom:
//   - read its description (the invited email/name/section) and members;
//   - verify the description's email hashes back to the team name (the team is
//     invitee-editable after acceptance, so this is the trust boundary — a
//     tampered email that no longer matches the slug is ignored);
//   - drop org owners (GitHub auto-adds the team creator as a maintainer), so
//     the remaining members are the accepted invitee(s);
//   - with exactly one non-owner member, backfill their email/name/section onto
//     that account's roster.csv row (creating an identity row if absent;
//     teacher-entered values always win), then delete the team;
//   - with zero non-owner members the invite is still pending — leave the team;
//   - with more than one, skip and warn (an anomaly — a hash collision or a
//     manually-added member) rather than guess which is the invitee.
//
// Best-effort and idempotent: a per-team failure is logged and skipped so one
// bad team never blocks the rest (or the enclosing reconcile). Scoped to one
// classroom via the description's `classroom` field, so a shared org running
// several classrooms only touches its own invite teams.
export async function backfillInviteMetadata(
  client: GitHubClient,
  input: { org: string; classroom: string },
): Promise<BackfillInviteMetadataResult> {
  const { org, classroom } = input
  const backfilled: string[] = []
  const deletedStale = 0

  const [inviteTeams, admins] = await Promise.all([
    listInviteTeams(client, org),
    listOrgAdmins(client, org),
  ])
  if (inviteTeams.length === 0) {
    return { backfilled, deletedStale }
  }
  const adminIds = new Set(admins.map((a) => a.id))
  const adminLogins = new Set(admins.map((a) => a.login.toLowerCase()))

  for (const team of inviteTeams) {
    const slug = team.slug
    if (!slug) continue
    try {
      const state = await readInviteTeam(client, org, slug)
      if (!state) continue // already deleted
      const record = state.description
      // Not a valid v1 record, or belongs to another classroom — leave it for
      // that classroom's own reconcile (or manual cleanup); never touch it here.
      if (!record || record.classroom !== classroom) continue

      // Trust boundary: the description is invitee-editable after acceptance, so
      // only act on it when the recorded email still hashes back to this team's
      // name. A tampered email can't redirect a backfill onto someone else.
      const expected = await inviteTeamName(classroom, record.email)
      if (expected !== slug) {
        log.error("invite team email does not match its name hash; skipping", {
          slug,
        })
        continue
      }

      // Accepted invitee(s) = members minus org owners (the auto-added creator).
      const invitees = state.members.filter(
        (m) => !adminIds.has(m.id) && !adminLogins.has(m.login.toLowerCase()),
      )
      if (invitees.length === 0) continue // still pending — keep the team
      if (invitees.length > 1) {
        log.error("invite team has multiple non-owner members; skipping", {
          slug,
          count: invitees.length,
        })
        continue
      }

      const invitee = invitees[0]
      await backfillRow(client, { org, classroom }, invitee, record)
      await deleteInviteTeam(client, org, slug)
      backfilled.push(record.email)
    } catch (err) {
      // One bad team must never block the rest or the enclosing reconcile.
      log.error("invite metadata backfill failed for team", { slug, err })
    }
  }

  return { backfilled, deletedStale }
}

// Write the invited email/name/section onto the accepted invitee's roster.csv
// row in one conflict-retried rewrite. Ensures an identity row exists (email
// invites write no row, so the accepted member may have none yet), then fills
// blank metadata fields — teacher-entered values always win (borrow-only). Never
// changes role/enrollment (team-driven). Matches the row by github_id, then
// login (the same identity join the roster view uses).
async function backfillRow(
  client: GitHubClient,
  input: { org: string; classroom: string },
  invitee: { id: number; login: string },
  record: InviteDescription,
): Promise<void> {
  const { org, classroom } = input
  const inviteeId = String(invitee.id)
  const loginKey = invitee.login.toLowerCase()

  await withRosterRewrite(client, { org, classroom }, (rows) => {
    const matches = (row: StudentCsvRow) => {
      const rowId = parseGitHubId(row.github_id)
      if (rowId !== null && String(rowId) === inviteeId) return true
      return row.username.trim().toLowerCase() === loginKey
    }
    const existing = rows.find(matches)

    // Borrow a blank field from the record; a teacher-set value always wins.
    const fill = (row: StudentCsvRow): StudentCsvRow =>
      normalizeStudentRow({
        ...row,
        username: row.username || invitee.login,
        github_id: row.github_id || inviteeId,
        first_name: row.first_name?.trim() || record.first_name || "",
        last_name: row.last_name?.trim() || record.last_name || "",
        email: row.email?.trim() || record.email,
        section: row.section?.trim() || record.section || "",
      })

    if (!existing) {
      // No row yet (the common email-invite case): append an identity row
      // carrying the recovered metadata.
      const added = normalizeStudentRow({
        username: invitee.login,
        github_id: inviteeId,
        first_name: record.first_name || "",
        last_name: record.last_name || "",
        email: record.email,
        section: record.section || "",
      })
      return {
        nextStudents: [...rows, added],
        changed: 1,
        message: `Backfill invited email for ${classroom}/${invitee.login}`,
      }
    }

    let changed = 0
    const nextStudents = rows.map((row) => {
      if (row !== existing) return row
      const filled = fill(row)
      // Only count a change when a field actually differs (avoid an empty commit
      // when the teacher already provided everything).
      if (
        filled.username !== row.username ||
        filled.github_id !== row.github_id ||
        filled.first_name !== row.first_name ||
        filled.last_name !== row.last_name ||
        filled.email !== row.email ||
        filled.section !== row.section
      ) {
        changed = 1
        return filled
      }
      return row
    })

    return {
      nextStudents,
      changed,
      message: `Backfill invited email for ${classroom}/${invitee.login}`,
    }
  })
}
