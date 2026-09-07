import { useState } from "react"
import { useTranslation } from "react-i18next"
import { InlineSpinner } from "@/components/Spinner"
import { ShieldIcon } from "@/components/ui/icons"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can } from "@/authz"
import { useClaimTeacher } from "@/hooks/mutations/useClaimTeacher"
import { Alert, Button, InlineMessage } from "@/components/ui"
import { errorText } from "@/types/localizedMessage"
import { logger } from "@/lib/logger"

const log = logger.scope("classroom:claim-teacher")

// Self-repair for the KTD-4 edge case: an org OWNER who is on none of a
// classroom's staff teams resolves to `student` there (org-admin no longer
// auto-teaches a classroom). New classrooms seed their creator onto the
// teacher team (createClassroomFiles), but a PRE-EXISTING classroom — or one
// whose creator left — can have no resolvable teacher. This surfaces an
// explicit, idempotent "add yourself as teacher" affordance so an owner can
// recover access in one click.
export function ClaimTeacherNotice({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) {
  const { t } = useTranslation()
  const { announce } = useToast()
  const { githubOrgRole } = useGitHubOrgRole()
  const { actualRole } = useClassroomRoleContext()
  const [claimError, setClaimError] = useState<string | null>(null)

  const claimMutation = useClaimTeacher(org, classroom, {
    somethingWentWrong: t("classes.somethingWentWrong"),
  })

  const claim = () => {
    setClaimError(null)
    claimMutation.mutate(undefined, {
      onSuccess: () => {
        // The notice itself disappears once the role refetch settles — SR
        // announcement only.
        announce(t("classes.claimTeacher.success"))
      },
      onError: (err) => {
        log.warn("claim teacher failed", { org, classroom, err })
        // Rendered inside this notice (Primer: feedback next to the control
        // that caused it).
        setClaimError(
          t("classes.claimTeacher.failed", {
            message: errorText(t, err),
          }),
        )
      },
    })
  }

  // Only an org owner who currently resolves to `student` here needs repair. A
  // TA/teacher of this classroom, or a non-owner, never sees it. `unresolved`
  // holds the affordance back (fail-closed — don't offer it mid-resolution).
  if (!can("claimTeacher", { githubOrgRole, classroomRole: actualRole }))
    return null

  return (
    <Alert
      tone="info"
      className="mb-4 flex-col items-start gap-2 sm:flex-row sm:items-center sm:flex-wrap"
    >
      <ShieldIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="flex-1 text-sm">
        {t("classes.claimTeacher.message")}
      </span>
      <Button
        variant="primary"
        size="sm"
        disabled={claimMutation.isPending}
        onClick={() => claim()}
      >
        {claimMutation.isPending ? (
          <InlineSpinner />
        ) : (
          <ShieldIcon aria-hidden="true" className="size-4" />
        )}
        {t("classes.claimTeacher.action")}
      </Button>
      {claimError != null && (
        <InlineMessage tone="error" className="w-full">
          {claimError}
        </InlineMessage>
      )}
    </Alert>
  )
}

export default ClaimTeacherNotice
