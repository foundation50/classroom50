import type { GitHubClient } from "@/github-core/client"
import { bulkUnenrollStudents } from "@/domain/students"
import { getErrorMessage } from "@/github-core/errorMessage"
import { studentKey } from "@/util/identity"
import type { Student } from "@/types/classroom"
import type { OrgMemberRow } from "@/util/orgMembers"
import { logger } from "@/lib/logger"

const log = logger.scope("orgMembers:bulkRemoveFromClassroom")

export type BulkRemoveProgress = {
  processed: number
  total: number
  message: string
}

export type BulkRemoveOutcome = {
  key: string
  label: string
  status: "removed" | "skipped" | "failed"
  // Present for skipped/failed rows.
  detail?: string
}

export type BulkRemoveFromClassroomResult = {
  outcomes: BulkRemoveOutcome[]
  removedCount: number
  // Non-fatal per-student side-effect warnings (team drop / invite cancel).
  warnings: string[]
}

const labelFor = (row: OrgMemberRow) => row.username || row.email || row.key

// Reconstruct the minimal Student the roster matcher keys on (username /
// github_id / email). Mirrors removeMemberFromOrg.rowToStudent.
const rowToStudent = (row: OrgMemberRow): Student => ({
  username: row.username,
  first_name: "",
  last_name: "",
  email: row.email,
  section: "",
  github_id: row.github_id,
  role: "",
})

// Remove selected members from ONE classroom in a SINGLE roster commit (drops
// CSV rows + classroom-team membership, cancels pending invites; org membership
// stays intact — that's the separate, guarded "Remove from organization"
// action).
//
// Delegates the write to bulkUnenrollStudents, which drops every matched row in
// one commit instead of one-per-student, avoiding N racing "Remove student"
// commits cluttering roster.csv history.
//
// This layer owns the per-row PRE-filtering the members view needs:
//   - rows not on the target classroom (nothing to remove) -> skipped
//   - rows on an ARCHIVED instance -> skipped (read-only; the write would throw)
// so only removable rows reach the batch writer. Per-row outcomes are
// reconciled from the batch result (removed / not-found).
export async function bulkRemoveFromClassroom(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    rows: OrgMemberRow[]
    onProgress?: (progress: BulkRemoveProgress) => void
  },
): Promise<BulkRemoveFromClassroomResult> {
  const { org, classroom, rows, onProgress } = input

  const outcomes: BulkRemoveOutcome[] = []
  const eligible: OrgMemberRow[] = []

  for (const row of rows) {
    const access = row.classrooms.find((c) => c.classroom === classroom)
    if (!access) {
      outcomes.push({
        key: row.key,
        label: labelFor(row),
        status: "skipped",
        detail: "not-on-classroom",
      })
      continue
    }
    if (access.archived) {
      outcomes.push({
        key: row.key,
        label: labelFor(row),
        status: "skipped",
        detail: "archived",
      })
      continue
    }
    eligible.push(row)
  }

  if (eligible.length === 0) {
    return { outcomes, removedCount: 0, warnings: [] }
  }

  // Map each eligible row to the Student we send, keeping the row alongside so
  // outcomes reconcile back to a row key/label.
  const byStudent = eligible.map((row) => ({ row, student: rowToStudent(row) }))

  try {
    const result = await bulkUnenrollStudents(client, {
      org,
      classroom,
      students: byStudent.map((b) => b.student),
      onProgress,
    })

    // Reconcile the batch result to per-row outcomes by studentKey (shared
    // identity precedence github_id || username || email), not object ref: a
    // person in `removed` was dropped; one only in `notFound` was already gone
    // at write time (racing edit / prior removal) — distinct from the pre-filter
    // "not-on-classroom". rowToStudent copies identity fields so both sides key
    // alike.
    const removedKeys = new Set(result.removed.map((s) => studentKey(s)))
    for (const { row } of byStudent) {
      const wasRemoved = removedKeys.has(studentKey(row))
      outcomes.push({
        key: row.key,
        label: labelFor(row),
        status: wasRemoved ? "removed" : "skipped",
        detail: wasRemoved ? undefined : "already-removed",
      })
    }

    return {
      outcomes,
      removedCount: result.removed.length,
      warnings: result.warnings,
    }
  } catch (err) {
    // A hard failure of the single roster write fails the whole batch (nothing
    // committed). Report each eligible row as failed.
    log.warn("bulk remove from classroom failed (whole batch)", {
      org,
      classroom,
      count: byStudent.length,
      err,
    })
    const detail = getErrorMessage(err)
    for (const { row } of byStudent) {
      outcomes.push({
        key: row.key,
        label: labelFor(row),
        status: "failed",
        detail,
      })
    }
    return { outcomes, removedCount: 0, warnings: [] }
  }
}
