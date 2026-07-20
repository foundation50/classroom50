import { useTranslation } from "react-i18next"

import { Alert, Button, Select } from "@/components/ui"
import { ROLE_LABEL_KEY } from "@/util/classroomRoleUI"
import type { ClassroomRole } from "@/util/teamRoster"
import type { BulkInviteByEmailResult } from "@/domain/students"
import type { UploadKind } from "@/pages/students/uploadClassify"

// The "Detected format" header + override picker, rendered once above the
// preview branch split (the file is auto-classified on ingest; the teacher can
// correct the guess here before processing). One definition so a fourth format
// or a copy change lands in a single place.
export const DetectedFormatSelect = ({
  value,
  onChange,
}: {
  value: UploadKind
  onChange: (kind: UploadKind) => void
}) => {
  const { t } = useTranslation()
  return (
    <div className="mb-4 flex flex-col gap-1 rounded-box border border-base-300 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-base-content/70">
        {t("students.detectedFormat")}
      </span>
      <Select
        selectSize="sm"
        className="w-full sm:w-64"
        aria-label={t("students.detectedFormat")}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as UploadKind)}
      >
        <option value="roster-csv">{t("students.uploadKindRosterCsv")}</option>
        <option value="username-list">
          {t("students.uploadKindUsernameList")}
        </option>
        <option value="email-list">{t("students.uploadKindEmailList")}</option>
      </Select>
    </div>
  )
}

// The email-invite preview: the parsed addresses with a per-row role picker,
// the org-owner confirmation gate (shown only when an address is assigned
// teacher), and the send/cancel actions. Presentational — the parent owns
// the emails/roles/confirmation state and the send handler.
export const EmailInvitePreview = ({
  emails,
  emailRoles,
  emailOwnerConfirmed,
  emailHasTeacher,
  canProcess,
  onRoleChange,
  onOwnerConfirmedChange,
  onCancel,
  onSend,
}: {
  emails: string[]
  emailRoles: Record<string, ClassroomRole>
  emailOwnerConfirmed: boolean
  emailHasTeacher: boolean
  canProcess: boolean
  onRoleChange: (key: string, rawValue: string) => void
  onOwnerConfirmedChange: (confirmed: boolean) => void
  onCancel: () => void
  onSend: () => void
}) => {
  const { t } = useTranslation()
  return (
    <>
      <Alert tone="info" className="mb-2">
        <span>{t("students.emailsFound", { count: emails.length })}</span>
      </Alert>
      <Alert tone="info" className="mb-4">
        <span>{t("students.emailInviteNoRosterNotice")}</span>
      </Alert>

      {emails.length > 0 ? (
        <>
          <div className="max-h-80 overflow-auto rounded-box border border-base-300">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">{t("students.emailColumn")}</th>
                  <th scope="col">{t("students.roleColumn")}</th>
                </tr>
              </thead>
              <tbody>
                {emails.map((email, index) => {
                  const key = email.toLowerCase()
                  return (
                    <tr key={key}>
                      <td>{index + 1}</td>
                      <td>
                        <code>{email}</code>
                      </td>
                      <td>
                        <Select
                          selectSize="xs"
                          className="w-32"
                          aria-label={t("students.assignRoleLabel")}
                          value={emailRoles[key] ?? "student"}
                          onChange={(e) => {
                            // Read synchronously — React nulls currentTarget
                            // after the handler, so the parent's setState
                            // updater must not touch the event.
                            onRoleChange(key, e.target.value)
                          }}
                        >
                          <option value="student">
                            {t("students.roleStudent")}
                          </option>
                          <option value="ta">{t("students.roleTa")}</option>
                          <option value="hta">
                            {t("students.roleHeadTa")}
                          </option>
                          <option value="teacher">
                            {t("students.roleTeacher")}
                          </option>
                        </Select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {emailHasTeacher ? (
            <div className="mt-3 flex flex-col gap-2 rounded-box border border-error/30 bg-error/5 p-4">
              <Alert tone="warning">
                <span>{t("students.uploadTeacherOwnerNotice")}</span>
              </Alert>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="checkbox checkbox-sm mt-0.5"
                  checked={emailOwnerConfirmed}
                  onChange={(e) =>
                    onOwnerConfirmedChange(e.currentTarget.checked)
                  }
                />
                <span>{t("students.emailInviteConfirmOwner")}</span>
              </label>
            </div>
          ) : null}
        </>
      ) : (
        <Alert tone="warning">{t("students.noValidEmails")}</Alert>
      )}

      <div className="modal-action">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" disabled={!canProcess} onClick={onSend}>
          {t("students.sendInviteCount", { count: emails.length })}
        </Button>
      </div>
    </>
  )
}

// The email-invite result screen: the invited/skipped/deferred/failed buckets
// from a completed bulkInviteByEmail. Uses the passed section renderer so it
// reuses the modal's ImportResultSection without importing it (avoids a cycle).
export const EmailInviteResult = ({
  result,
  onDone,
  renderSection,
}: {
  result: BulkInviteByEmailResult
  onDone: () => void
  renderSection: (props: {
    title: string
    rows: { key: string; label: string; detail?: string }[]
  }) => React.ReactNode
}) => {
  const { t } = useTranslation()
  return (
    <div className="mt-6 space-y-4">
      <Alert tone="success">
        <span>
          {t("students.emailInvitedCount", { count: result.invited.length })}
        </span>
      </Alert>

      {result.invited.length > 0 &&
        renderSection({
          title: t("students.resultInvited"),
          rows: result.invited.map(({ email, role }) => ({
            key: email,
            label: email,
            detail: t(ROLE_LABEL_KEY[role]),
          })),
        })}
      {result.skipped.length > 0 &&
        renderSection({
          title: t("students.resultSkipped"),
          rows: result.skipped.map(({ email }) => ({
            key: email,
            label: email,
            detail: t("students.emailInviteSkippedDetail"),
          })),
        })}
      {result.deferred.length > 0 &&
        renderSection({
          title: t("students.resultInvitesDeferred"),
          rows: result.deferred.map((email) => ({
            key: email,
            label: email,
            detail: t("students.inviteDeferredDetail"),
          })),
        })}
      {result.failed.length > 0 &&
        renderSection({
          title: t("students.resultInvitesFailed"),
          rows: result.failed.map((f) => ({
            key: f.email,
            label: f.email,
            detail: f.message,
          })),
        })}

      <div className="modal-action">
        <Button variant="primary" onClick={onDone}>
          {t("students.done")}
        </Button>
      </div>
    </div>
  )
}
