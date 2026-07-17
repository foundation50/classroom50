import { useTranslation } from "react-i18next"
import { Alert, Badge } from "@/components/ui"
import { ROLE_LABEL_KEY } from "@/util/classroomRoleUI"
import type { PreflightResult } from "@/util/rosterUploadPreflight"

// A small summary tile for a preflight bucket (count + label). Zero-count
// buckets dim so the teacher's eye goes to what actually changes.
const PreflightBucket = ({
  tone,
  title,
  count,
}: {
  tone: "neutral" | "info" | "warning" | "error"
  title: string
  count: number
}) => {
  const toneClass =
    count === 0
      ? "border-base-300 opacity-50"
      : tone === "error"
        ? "border-error/40 bg-error/5"
        : tone === "warning"
          ? "border-warning/40 bg-warning/5"
          : tone === "info"
            ? "border-info/40 bg-info/5"
            : "border-base-300"
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-box border px-4 py-2.5 ${toneClass}`}
    >
      <span className="text-sm">{title}</span>
      <Badge>{count}</Badge>
    </div>
  )
}

// The resolved-preflight recap: the all-members / invite banner, the four
// action-bucket tiles, and the role-change/instructor-enroll confirmation box
// that gates the primary button. Rendered only once the preflight resolves.
export const PreflightRecap = ({
  preflight,
  roleChanges,
  instructorEnrolls,
  needsRoleConfirm,
  confirmGrantsOwner,
  roleChangesConfirmed,
  onRoleChangesConfirmedChange,
}: {
  preflight: PreflightResult
  roleChanges: PreflightResult["roleChanges"]
  instructorEnrolls: PreflightResult["enroll"]
  needsRoleConfirm: boolean
  confirmGrantsOwner: boolean
  roleChangesConfirmed: boolean
  onRoleChangesConfirmedChange: (checked: boolean) => void
}) => {
  const { t } = useTranslation()
  return (
    <div className="mb-4 flex flex-col gap-2">
      {preflight.allAlreadyMembers ? (
        <Alert tone="info">
          <span>{t("students.preflightAllMembersNote")}</span>
        </Alert>
      ) : preflight.needsInvite.length > 0 ? (
        <Alert tone="warning">
          <span>
            {t("students.uploadInviteNotice", {
              count: preflight.needsInvite.length,
            })}
          </span>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <PreflightBucket
          tone="neutral"
          title={t("students.preflightNoActionTitle")}
          count={preflight.noAction.length}
        />
        <PreflightBucket
          tone="warning"
          title={t("students.preflightInviteTitle")}
          count={preflight.needsInvite.length}
        />
        <PreflightBucket
          tone="info"
          title={t("students.preflightEnrollTitle")}
          count={preflight.enroll.length}
        />
        <PreflightBucket
          tone="error"
          title={t("students.preflightRoleChangeTitle")}
          count={preflight.roleChanges.length}
        />
      </div>

      {/* Team moves and org-owner grants need explicit confirmation: a role
          change is a destructive team move, and an instructor target (role
          change OR enroll) grants org OWNER. List each and gate the primary
          button on the checkbox. */}
      {needsRoleConfirm ? (
        <div className="mt-1 flex flex-col gap-2 rounded-box border border-error/30 bg-error/5 p-4">
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
            {instructorEnrolls.map((e) => (
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
                count: roleChanges.length + instructorEnrolls.length,
              })}
            </span>
          </label>
        </div>
      ) : null}
    </div>
  )
}
