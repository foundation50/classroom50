import type { GitHubClient } from "@/hooks/github/client"
import { bulkUnenrollStudents } from "@/api/mutations/students"
import { getErrorMessage } from "@/hooks/github/mutations"
import { studentKey } from "@/util/identity"
import { rowToStudent, type TeamRosterRow } from "@/util/teamRoster"
import { logger } from "@/lib/logger"

const log = logger.scope("students:bulkUnenrollRoster")

export type BulkUnenrollRosterProgress = {
  processed: number
  total: number
  message: string
}

export type BulkUnenrollRosterOutcome = {
  key: string
  label: string
  status: "removed" | "skipped" | "failed"
  // Present for skipped/failed rows: a reason token or message.
  detail?: string
}

export type BulkUnenrollRosterResult = {
  outcomes: BulkUnenrollRosterOutcome[]
  removedCount: number
  // Non-fatal per-student side-effect warnings (team drop / invite cancel).
  warnings: string[]
}

const labelFor = (row: TeamRosterRow) => row.username || row.email || row.key

// Remove selected roster rows from ONE classroom in a single roster commit,
// delegating to bulkUnenrollStudents (drops CSV rows + classroom-team
// membership, cancels still-pending invites; org membership stays intact). The
// roster analog of bulkRemoveFromClassroom, but keyed on TeamRosterRow — roster
// rows have no OrgMemberRow.classrooms[] to pre-filter on, so every selected row
// is a target and per-row outcomes are reconciled from the batch result.
export async function bulkUnenrollRoster(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    rows: TeamRosterRow[]
    onProgress?: (progress: BulkUnenrollRosterProgress) => void
  },
): Promise<BulkUnenrollRosterResult> {
  const { org, classroom, rows, onProgress } = input

  if (rows.length === 0) {
    return { outcomes: [], removedCount: 0, warnings: [] }
  }

  const byStudent = rows.map((row) => ({ row, student: rowToStudent(row) }))

  try {
    const result = await bulkUnenrollStudents(client, {
      org,
      classroom,
      students: byStudent.map((b) => b.student),
      onProgress,
    })

    // Reconcile per-row by studentKey (shared identity precedence): a person in
    // `removed` was dropped; one only in `notFound` was already gone at write
    // time (racing edit / prior removal).
    const removedKeys = new Set(result.removed.map((s) => studentKey(s)))
    const outcomes: BulkUnenrollRosterOutcome[] = byStudent.map(({ row }) => {
      const wasRemoved = removedKeys.has(studentKey(row))
      return {
        key: row.key,
        label: labelFor(row),
        status: wasRemoved ? "removed" : "skipped",
        detail: wasRemoved ? undefined : "already-removed",
      }
    })

    return {
      outcomes,
      removedCount: result.removed.length,
      warnings: result.warnings,
    }
  } catch (err) {
    // A hard failure of the single roster write fails the whole batch (nothing
    // committed). Report each row as failed.
    log.warn("bulk unenroll roster failed (whole batch)", {
      org,
      classroom,
      count: byStudent.length,
      err,
    })
    const detail = getErrorMessage(err)
    const outcomes: BulkUnenrollRosterOutcome[] = byStudent.map(({ row }) => ({
      key: row.key,
      label: labelFor(row),
      status: "failed",
      detail,
    }))
    return { outcomes, removedCount: 0, warnings: [] }
  }
}
