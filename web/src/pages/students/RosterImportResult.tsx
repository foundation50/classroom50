import { useTranslation } from "react-i18next"
import { Alert, Button } from "@/components/ui"
import { ROLE_LABEL_KEY } from "@/util/classroomRoleUI"
import type { BulkImportResult } from "@/domain/students"
import type { InviteOutcome, RoleChangeOutcome } from "./runRosterImport"

export type ImportResultSectionRow = {
  key: string
  label: string
  detail?: string
}

// A titled, scrollable table of result rows (code + detail). Shared by the
// roster-result view below and the email-invite result (via renderSection).
export const ImportResultSection = ({
  title,
  rows,
}: {
  title: string
  rows: ImportResultSectionRow[]
}) => {
  return (
    <div>
      <h4 className="font-bold mb-2">{title}</h4>

      <div className="max-h-48 overflow-auto rounded-box border border-base-300">
        <table className="table table-sm">
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <code>{row.key}</code>
                </td>
                <td className="opacity-70">{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// The completed roster-import view: the added-count banner, an optional invite-
// pass error, and per-outcome result sections (added / skipped / team failures /
// invited / deferred / failed / role changes / role-change failures).
export const RosterImportResult = ({
  result,
  inviteError,
  inviteOutcome,
  roleChangeOutcome,
  onDone,
}: {
  result: BulkImportResult
  inviteError: string | null
  inviteOutcome: InviteOutcome | null
  roleChangeOutcome: RoleChangeOutcome | null
  onDone: () => void
}) => {
  const { t } = useTranslation()
  return (
    <div className="mt-6 space-y-4">
      <Alert tone="success">
        <span>
          {t("students.addedCount", { count: result.addedStudents.length })}
        </span>
      </Alert>

      {inviteError && (
        <Alert tone="error">
          <span>
            {t("students.invitePassFailed", { message: inviteError })}
          </span>
        </Alert>
      )}

      {result.addedStudents.length > 0 && (
        <ImportResultSection
          title={t("students.resultAdded")}
          rows={result.addedStudents.map((student) => ({
            key: student.username,
            label: student.username,
            detail: [student.first_name, student.last_name]
              .filter(Boolean)
              .join(" "),
          }))}
        />
      )}

      {result.skippedStudents.length > 0 && (
        <ImportResultSection
          title={t("students.resultSkipped")}
          rows={result.skippedStudents.map((student) => ({
            key: student.username,
            label: student.username,
            detail: student.message ?? student.reason,
          }))}
        />
      )}

      {result.teamResults?.some(
        (teamResult) => teamResult.status === "failed",
      ) && (
        <ImportResultSection
          title={t("students.resultTeamFailures")}
          rows={result.teamResults
            .filter((teamResult) => teamResult.status === "failed")
            .map((teamResult) => ({
              key: teamResult.username,
              label: teamResult.username,
              detail: teamResult.message ?? t("students.couldNotAddToTeam"),
            }))}
        />
      )}

      {inviteOutcome && inviteOutcome.invited.length > 0 && (
        <ImportResultSection
          title={t("students.resultInvited")}
          rows={inviteOutcome.invited.map(({ username, role }) => ({
            key: username,
            label: username,
            detail: t(ROLE_LABEL_KEY[role]),
          }))}
        />
      )}

      {inviteOutcome && inviteOutcome.deferred.length > 0 && (
        <ImportResultSection
          title={t("students.resultInvitesDeferred")}
          rows={inviteOutcome.deferred.map((username) => ({
            key: username,
            label: username,
            detail: t("students.inviteDeferredDetail"),
          }))}
        />
      )}

      {inviteOutcome && inviteOutcome.failed.length > 0 && (
        <ImportResultSection
          title={t("students.resultInvitesFailed")}
          rows={inviteOutcome.failed.map((f) => ({
            key: f.username,
            label: f.username,
            detail: f.message,
          }))}
        />
      )}

      {roleChangeOutcome && roleChangeOutcome.changed.length > 0 && (
        <ImportResultSection
          title={t("students.resultRoleChanged")}
          rows={roleChangeOutcome.changed.map((c) => ({
            key: c.username,
            label: c.username,
            detail: t(ROLE_LABEL_KEY[c.to]),
          }))}
        />
      )}

      {roleChangeOutcome && roleChangeOutcome.failed.length > 0 && (
        <ImportResultSection
          title={t("students.resultRoleChangeFailures")}
          rows={roleChangeOutcome.failed.map((f, i) => ({
            key: `${f.username}-${i}`,
            label: f.username,
            detail: f.message,
          }))}
        />
      )}

      <div className="modal-action">
        <Button variant="primary" onClick={onDone}>
          {t("students.done")}
        </Button>
      </div>
    </div>
  )
}
