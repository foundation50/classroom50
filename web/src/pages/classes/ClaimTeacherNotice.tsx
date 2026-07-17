import { useTranslation } from "react-i18next"
import { Loader2, ShieldPlus } from "lucide-react"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can } from "@/authz"
import { useClaimTeacher } from "@/hooks/mutations/useClaimTeacher"
import { Alert, Button } from "@/components/ui"
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
  const { notify } = useToast()
  const { githubOrgRole } = useGitHubOrgRole()
  const { actualRole } = useClassroomRoleContext()

  const claimMutation = useClaimTeacher(org, classroom, {
    somethingWentWrong: t("classes.somethingWentWrong"),
  })

  const claim = () =>
    claimMutation.mutate(undefined, {
      onSuccess: () => {
        notify({
          tone: "success",
          message: t("classes.claimTeacher.success"),
        })
      },
      onError: (err) => {
        log.warn("claim teacher failed", { org, classroom, err })
        notify({
          tone: "error",
          message: t("classes.claimTeacher.failed", {
            message:
              err instanceof Error
                ? err.message
                : t("classes.somethingWentWrong"),
          }),
        })
      },
    })

  // Only an org owner who currently resolves to `student` here needs repair. A
  // TA/teacher of this classroom, or a non-owner, never sees it. `unresolved`
  // holds the affordance back (fail-closed — don't offer it mid-resolution).
  if (!can("claimTeacher", { githubOrgRole, classroomRole: actualRole }))
    return null

  return (
    <Alert
      tone="info"
      className="mb-4 flex-col items-start gap-2 sm:flex-row sm:items-center"
    >
      <ShieldPlus aria-hidden="true" className="size-5 shrink-0" />
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
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <ShieldPlus aria-hidden="true" className="size-4" />
        )}
        {t("classes.claimTeacher.action")}
      </Button>
    </Alert>
  )
}

export default ClaimTeacherNotice
