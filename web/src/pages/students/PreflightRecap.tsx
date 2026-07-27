import { useTranslation } from "react-i18next"
import { Alert } from "@/components/ui"
import { ROLE_LABEL_KEY } from "@/util/classroomRoleUI"
import type { PreflightResult } from "@/util/rosterUploadPreflight"

// The confirmation gate for a resolved preflight: the destructive/owner-granting
// role-move box and the non-destructive detail-update box. The at-a-glance
// counts live in PreflightSummary and the per-row detail in the preview table;
// this component is now only the checkboxes that gate the primary button, shown
// only when a confirmation is actually required.
export const PreflightRecap = ({
  roleChanges,
  teacherEnrolls,
  needsRoleConfirm,
  confirmGrantsOwner,
  roleChangesConfirmed,
  onRoleChangesConfirmedChange,
  needsMetadataConfirm,
  metadataUpdateCount,
  metadataConfirmed,
  onMetadataConfirmedChange,
}: {
  roleChanges: PreflightResult["roleChanges"]
  teacherEnrolls: PreflightResult["enroll"]
  needsRoleConfirm: boolean
  confirmGrantsOwner: boolean
  roleChangesConfirmed: boolean
  onRoleChangesConfirmedChange: (checked: boolean) => void
  needsMetadataConfirm: boolean
  metadataUpdateCount: number
  metadataConfirmed: boolean
  onMetadataConfirmedChange: (checked: boolean) => void
}) => {
  const { t } = useTranslation()
  if (!needsRoleConfirm && !needsMetadataConfirm) return null
  return (
    <div className="mb-4 flex flex-col gap-2">
      {/* Team moves and org-owner grants need explicit confirmation: a role
          change is a destructive team move, and a teacher target (role
          change OR enroll) grants org OWNER. Metadata deltas for these rows are
          shown inline in the preview table (highlighted cells), not re-listed. */}
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
            <input
              type="checkbox"
              className="checkbox checkbox-sm mt-0.5"
              checked={roleChangesConfirmed}
              onChange={(e) =>
                onRoleChangesConfirmedChange(e.currentTarget.checked)
              }
            />
            <span>
              {t("students.preflightConfirmRoleChanges", {
                count: roleChanges.length + teacherEnrolls.length,
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
            <input
              type="checkbox"
              className="checkbox checkbox-sm mt-0.5"
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
