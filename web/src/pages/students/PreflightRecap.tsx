import { useTranslation } from "react-i18next"
import { Alert, Checkbox } from "@/components/ui"
import { ROLE_LABEL_KEY } from "@/util/classroomRoleUI"
import type { PreflightResult } from "@/util/rosterUploadPreflight"

// The confirmation gate for a resolved preflight: the identity-mismatch box, the
// destructive/owner-granting role-move box, and the non-destructive
// detail-update box. The at-a-glance counts live in PreflightSummary and the
// per-row detail in the preview table; this component is only the checkboxes that
// gate the primary button, shown only when a confirmation is actually required.
export const PreflightRecap = ({
  roleChanges,
  teacherEnrolls,
  teacherEmailCount = 0,
  needsRoleConfirm,
  confirmGrantsOwner,
  roleChangesConfirmed,
  onRoleChangesConfirmedChange,
  needsMetadataConfirm,
  metadataUpdateCount,
  metadataConfirmed,
  onMetadataConfirmedChange,
  identityMismatches = [],
  mismatchConfirmed,
  onMismatchConfirmedChange,
}: {
  roleChanges: PreflightResult["roleChanges"]
  teacherEnrolls: PreflightResult["enroll"]
  // People who will be granted org OWNER without a team move: a teacher-role
  // enroll, invitation, or email invitation. They belong in this gate's count and
  // notice even though none of them is a role CHANGE.
  teacherEmailCount?: number
  needsRoleConfirm: boolean
  confirmGrantsOwner: boolean
  roleChangesConfirmed: boolean
  onRoleChangesConfirmedChange: (checked: boolean) => void
  needsMetadataConfirm: boolean
  metadataUpdateCount: number
  metadataConfirmed: boolean
  onMetadataConfirmedChange: (checked: boolean) => void
  identityMismatches?: PreflightResult["identityMismatches"]
  mismatchConfirmed: boolean
  onMismatchConfirmedChange: (checked: boolean) => void
}) => {
  const { t } = useTranslation()
  const needsMismatchConfirm = identityMismatches.length > 0
  if (!needsRoleConfirm && !needsMetadataConfirm && !needsMismatchConfirm) {
    return null
  }
  return (
    <div className="mb-4 flex flex-col gap-2">
      {/* First, because it questions WHO the other boxes are about. Warning tone,
          not error: nothing destructive happens on confirm — the import just
          proceeds under the account the id addresses. The error tone stays
          reserved for the team move below. */}
      {needsMismatchConfirm ? (
        <div className="flex flex-col gap-2 rounded-box border border-warning/40 bg-warning/10 p-4">
          <h4 className="text-sm font-semibold">
            {t("students.preflightIdentityConfirmTitle")}
          </h4>
          <p className="text-sm opacity-70">
            {t("students.preflightIdentityHint")}
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {identityMismatches.map((m) => (
              <li
                key={`mismatch-${m.github_id}`}
                className="flex items-center justify-between gap-2"
              >
                <code>{m.username}</code>
                <span className="opacity-70">
                  {t("students.preflightIdentityDetail", {
                    declared: m.declaredUsername,
                    id: m.github_id,
                  })}
                </span>
              </li>
            ))}
          </ul>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={mismatchConfirmed}
              onChange={(e) =>
                onMismatchConfirmedChange(e.currentTarget.checked)
              }
            />
            <span>
              {t("students.preflightConfirmIdentity", {
                count: identityMismatches.length,
              })}
            </span>
          </label>
        </div>
      ) : null}

      {/* Team moves and org-owner grants need explicit confirmation: a role
          change is a destructive team move, and a teacher target (role
          change, enroll, OR email invitation) grants org OWNER. Metadata deltas
          for these rows are shown inline in the preview table (highlighted
          cells), not re-listed. */}
      {needsRoleConfirm ? (
        <div className="flex flex-col gap-2 rounded-box border border-error/30 bg-error/5 p-4">
          <h4 className="text-sm font-semibold">
            {t("students.preflightConfirmTitle")}
          </h4>
          <ul className="flex flex-col gap-1 text-sm">
            {roleChanges.map((c) => (
              <li
                key={`change-${c.username}`}
                className="flex items-center justify-between gap-2"
              >
                <code>{c.username}</code>
                <span className="opacity-70">
                  {t("students.preflightRoleChangeDetail", {
                    from: t(ROLE_LABEL_KEY[c.currentRole]),
                    to: t(ROLE_LABEL_KEY[c.role]),
                  })}
                </span>
              </li>
            ))}
            {teacherEnrolls.map((e) => (
              <li
                key={`enroll-${e.username}`}
                className="flex items-center justify-between gap-2"
              >
                <code>{e.username}</code>
                <span className="opacity-70">
                  {t("students.preflightEnrollOwnerDetail")}
                </span>
              </li>
            ))}
          </ul>
          {teacherEmailCount > 0 ? (
            <p className="text-sm opacity-70">
              {t("students.preflightTeacherEmailNotice", {
                count: teacherEmailCount,
              })}
            </p>
          ) : null}
          {confirmGrantsOwner ? (
            <Alert tone="warning">
              <span>{t("students.preflightRoleChangeOwnerNotice")}</span>
            </Alert>
          ) : null}
          {roleChanges.some((c) => c.changes.length > 0) ? (
            <p className="text-sm opacity-70">
              {t("students.preflightRoleChangeMetadataNotice")}
            </p>
          ) : null}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={roleChangesConfirmed}
              onChange={(e) =>
                onRoleChangesConfirmedChange(e.currentTarget.checked)
              }
            />
            <span>
              {t("students.preflightConfirmRoleChanges", {
                count:
                  roleChanges.length +
                  teacherEnrolls.length +
                  teacherEmailCount,
              })}
            </span>
          </label>
        </div>
      ) : null}

      {/* Metadata updates are non-destructive: they only change stored name/
          email/section. The changed values are highlighted in place in the
          preview table (hover for the stored -> CSV detail); this box gates the
          write. */}
      {needsMetadataConfirm ? (
        <div className="flex flex-col gap-2 rounded-box border border-warning/40 bg-warning/10 p-4">
          <h4 className="text-sm font-semibold">
            {t("students.preflightMetadataConfirmTitle")}
          </h4>
          <p className="text-sm opacity-70">
            {t("students.preflightMetadataReviewHint", {
              count: metadataUpdateCount,
            })}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={metadataConfirmed}
              onChange={(e) =>
                onMetadataConfirmedChange(e.currentTarget.checked)
              }
            />
            <span>
              {t("students.preflightConfirmMetadata", {
                count: metadataUpdateCount,
              })}
            </span>
          </label>
        </div>
      ) : null}
    </div>
  )
}
