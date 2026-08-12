import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangle } from "lucide-react"

import { Alert, Button } from "@/components/ui"
import { MigrateSubmissionTrackingModal } from "@/components/modals/MigrateSubmissionTrackingModal"
import useGetClassroomAssignments from "@/hooks/useGetClassAssignments"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import { can } from "@/authz"

type ClassroomMigrationBannerProps = {
  org: string | undefined
  classroom: string | undefined
}

// MIGRATION(v1.28): the classroom-level schema-migration banner. Safe to remove
// in a future version once no legacy (submission_mode-absent) files remain.
// Greppable tag: MIGRATION(v1.28).
// A classroom-level, persist-across-subviews prompt to migrate a pre-1.28
// assignments.json to explicit submission-tracking semantics. Rendered once in
// the classroom layout so it stays visible on every subview (submissions,
// roster, settings, …) until the teacher migrates — a legacy file (any entry
// with no explicit submission_mode) keeps the detection overlay off, so this is
// the single opt-in surface. Owner + authoring-tier only, and it self-hides the
// moment every assignment carries an explicit submission_mode.
export function ClassroomMigrationBanner({
  org,
  classroom,
}: ClassroomMigrationBannerProps) {
  const { t } = useTranslation()
  const { role: classroomRole } = useClassroomRoleContext()
  const { isOwner } = useIsOrgOwner()
  const { data: assignmentData } = useGetClassroomAssignments(org, classroom)
  const [open, setOpen] = useState(false)

  const canAuthor = can("authorAssignments", { classroomRole })
  const hasLegacy = (assignmentData?.assignments ?? []).some(
    (a) => a.submission_mode === undefined,
  )

  if (!org || !classroom || !isOwner || !canAuthor || !hasLegacy) return null

  return (
    <>
      <Alert
        tone="error"
        soft={false}
        role="status"
        className="rounded-none border-x-0"
      >
        <AlertTriangle className="size-5 shrink-0" aria-hidden="true" />
        <span className="flex-1">
          {t("submissions.migrateTracking.bannerText")}
        </span>
        <Button variant="neutral" size="sm" onClick={() => setOpen(true)}>
          {t("submissions.migrateTracking.bannerAction")}
        </Button>
      </Alert>
      <MigrateSubmissionTrackingModal
        open={open}
        onClose={() => setOpen(false)}
        org={org}
        classroom={classroom}
      />
    </>
  )
}

export default ClassroomMigrationBanner
