import { useTranslation } from "react-i18next"
import { Alert } from "@/components/ui"
import { ROLE_LABEL_KEY } from "@/util/classroomRoleUI"
import type {
  BulkImportResult,
  BulkInviteByEmailResult,
} from "@/domain/students"
import type { InviteOutcome, RoleChangeOutcome } from "./runRosterImport"

type ImportResultSectionRow = {
  key: string
  label: string
  detail?: string
}

// The four buckets a completed bulkInviteByEmail produces, as titled sections.
// Titles are passed in because "invited" by address must not read as "invited" by
// handle on a screen that reports both.
const emailInviteSections = (
  result: BulkInviteByEmailResult,
  t: (key: string) => string,
  titles: {
    invited: string
    skipped: string
    deferred: string
    failed: string
  },
): { title: string; rows: ImportResultSectionRow[] }[] =>
  [
    {
      title: titles.invited,
      rows: result.invited.map(({ email, role }) => ({
        key: email,
        label: email,
        detail: t(ROLE_LABEL_KEY[role]),
      })),
    },
    {
      title: titles.skipped,
      rows: result.skipped.map(({ email }) => ({
        key: email,
        label: email,
        detail: t("students.emailInviteSkippedDetail"),
      })),
    },
    {
      title: titles.deferred,
      rows: result.deferred.map((email) => ({
        key: email,
        label: email,
        detail: t("students.inviteDeferredDetail"),
      })),
    },
    {
      title: titles.failed,
      rows: result.failed.map((f) => ({
        key: f.email,
        label: f.email,
        detail: f.message,
      })),
    },
  ].filter((section) => section.rows.length > 0)

// A titled, scrollable table of result rows (code + detail).
const ImportResultSection = ({
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

// The completed roster-import view: one banner covering both passes, optional
// invite/email-pass errors, and per-outcome result sections (added / skipped /
// team failures / invited / deferred / failed / role changes / role-change
// failures), followed by the email-invite buckets when the batch carried
// email-identity rows. One screen, one Done button — a mixed batch must not paint
// two stacked result panels.
export const RosterImportResult = ({
  result,
  inviteError,
  inviteOutcome,
  roleChangeOutcome,
  emailResult = null,
  emailError = null,
}: {
  result: BulkImportResult
  inviteError: string | null
  inviteOutcome: InviteOutcome | null
  roleChangeOutcome: RoleChangeOutcome | null
  emailResult?: BulkInviteByEmailResult | null
  emailError?: string | null
}) => {
  const { t } = useTranslation()
  const emailInvitedCount = emailResult?.invited.length ?? 0
  return (
    <div className="mt-6 space-y-4">
      <Alert tone="success">
        <span>
          {emailInvitedCount > 0
            ? t("students.importedAndInvitedCount", {
                added: result.addedStudents.length,
                invited: emailInvitedCount,
              })
            : t("students.addedCount", { count: result.addedStudents.length })}
        </span>
      </Alert>

      {inviteError && (
        <Alert tone="error">
          <span>
            {t("students.invitePassFailed", { message: inviteError })}
          </span>
        </Alert>
      )}

      {emailError && (
        <Alert tone="error">
          <span>
            {t("students.emailInvitePassFailed", { message: emailError })}
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

      {/* The email pass's buckets, under titles distinct from the account ones so
          "invited" by address never reads as "invited" by handle. */}
      {emailResult
        ? emailInviteSections(emailResult, t, {
            invited: t("students.resultEmailInvited"),
            skipped: t("students.resultEmailSkipped"),
            deferred: t("students.resultEmailInvitesDeferred"),
            failed: t("students.resultEmailInvitesFailed"),
          }).map((section) => (
            <ImportResultSection key={section.title} {...section} />
          ))
        : null}
    </div>
  )
}
