import { useTranslation } from "react-i18next"
import { Alert, Badge } from "@/components/ui"
import { ROLE_LABEL_KEY } from "@/util/classroomRoleUI"
import type { PreflightResult } from "@/util/rosterUploadPreflight"
import type { MetadataField } from "@/util/rosterMetadataMerge"

// i18n label key per updatable metadata field, for the per-field change list.
const METADATA_FIELD_LABEL_KEY: Record<MetadataField, string> = {
  first_name: "students.firstNameColumn",
  last_name: "students.lastNameColumn",
  email: "students.emailColumn",
  section: "students.sectionColumn",
}

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
// action-bucket tiles, and the role-change/teacher-enroll confirmation box
// that gates the primary button. Rendered only once the preflight resolves.
export const PreflightRecap = ({
  preflight,
  roleChanges,
  teacherEnrolls,
  needsRoleConfirm,
  confirmGrantsOwner,
  roleChangesConfirmed,
  onRoleChangesConfirmedChange,
  needsMetadataConfirm,
  metadataConfirmed,
  onMetadataConfirmedChange,
}: {
  preflight: PreflightResult
  roleChanges: PreflightResult["roleChanges"]
  teacherEnrolls: PreflightResult["enroll"]
  needsRoleConfirm: boolean
  confirmGrantsOwner: boolean
  roleChangesConfirmed: boolean
  onRoleChangesConfirmedChange: (checked: boolean) => void
  needsMetadataConfirm: boolean
  metadataConfirmed: boolean
  onMetadataConfirmedChange: (checked: boolean) => void
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
        <PreflightBucket
          tone="info"
          title={t("students.preflightMetadataTitle")}
          count={preflight.metadataUpdate?.length ?? 0}
        />
      </div>

      {/* Team moves and org-owner grants need explicit confirmation: a role
          change is a destructive team move, and a teacher target (role
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
                className="flex flex-col gap-0.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <code>{c.username}</code>
                  <span className="opacity-70">
                    {t("students.preflightRoleChangeDetail", {
                      from: t(ROLE_LABEL_KEY[c.currentRole]),
                      to: t(ROLE_LABEL_KEY[c.role]),
                    })}
                  </span>
                </div>
                {c.changes.length > 0 ? (
                  <ul className="ml-4 flex flex-col gap-0.5 opacity-70">
                    {c.changes.map((chg) => (
                      <li key={chg.field}>
                        {t("students.preflightMetadataDetail", {
                          field: t(METADATA_FIELD_LABEL_KEY[chg.field]),
                          from:
                            chg.from || t("students.preflightMetadataEmpty"),
                          to: chg.to,
                        })}
                      </li>
                    ))}
                  </ul>
                ) : null}
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

      {/* Metadata updates are non-destructive (info tone, not error): they only
          change stored name/email/section, never team membership. Still gated
          behind their own checkbox, listing a per-field stored -> CSV delta so
          the teacher sees what each value replaces before confirming (R9). */}
      {needsMetadataConfirm ? (
        <div className="mt-1 flex flex-col gap-2 rounded-box border border-info/30 bg-info/5 p-4">
          <h4 className="text-sm font-semibold">
            {t("students.preflightMetadataConfirmTitle")}
          </h4>
          <ul className="flex flex-col gap-2 text-sm">
            {preflight.metadataUpdate.map((m) => (
              <li key={`meta-${m.username}`} className="flex flex-col gap-0.5">
                <code>{m.username}</code>
                <ul className="ml-4 flex flex-col gap-0.5 opacity-70">
                  {m.changes.map((c) => (
                    <li key={c.field}>
                      {t("students.preflightMetadataDetail", {
                        field: t(METADATA_FIELD_LABEL_KEY[c.field]),
                        from: c.from || t("students.preflightMetadataEmpty"),
                        to: c.to,
                      })}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
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
                count: preflight.metadataUpdate.length,
              })}
            </span>
          </label>
        </div>
      ) : null}
    </div>
  )
}
