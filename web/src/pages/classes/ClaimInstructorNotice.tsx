import { useTranslation } from "react-i18next"
import { Loader2, ShieldPlus } from "lucide-react"
import { useToast } from "@/context/notifications/NotificationProvider"
import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can } from "@/util/capabilities"
import { useClaimInstructor } from "@/hooks/mutations/useClaimInstructor"
import { Alert, Button } from "@/components/ui"
import { logger } from "@/lib/logger"

const log = logger.scope("classroom:claim-instructor")

// Self-repair for the KTD-4 edge case: an org OWNER who is on none of a
// classroom's staff teams resolves to `student` there (org-admin no longer
// auto-instructs a classroom). New classrooms seed their creator onto the
// instructor team (createClassroomFiles), but a PRE-EXISTING classroom — or one
// whose creator left — can have no resolvable instructor. This surfaces an
// explicit, idempotent "add yourself as instructor" affordance so an owner can
// recover access in one click.
export function ClaimInstructorNotice({
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

  const claimMutation = useClaimInstructor(org, classroom, {
    somethingWentWrong: t("classes.somethingWentWrong"),
  })

  const claim = () =>
    claimMutation.mutate(undefined, {
      onSuccess: () => {
        notify({
          tone: "success",
          message: t("classes.claimInstructor.success"),
        })
      },
      onError: (err) => {
        log.warn("claim instructor failed", { org, classroom, err })
        notify({
          tone: "error",
          message: t("classes.claimInstructor.failed", {
            message:
              err instanceof Error
                ? err.message
                : t("classes.somethingWentWrong"),
          }),
        })
      },
    })

  // Only an org owner who currently resolves to `student` here needs repair. A
  // TA/instructor of this classroom, or a non-owner, never sees it. `unresolved`
  // holds the affordance back (fail-closed — don't offer it mid-resolution).
  if (!can("claimInstructor", { githubOrgRole, classroomRole: actualRole }))
    return null

  return (
    <Alert
      tone="info"
      className="mb-4 flex-col items-start gap-2 sm:flex-row sm:items-center"
    >
      <ShieldPlus aria-hidden="true" className="size-5 shrink-0" />
      <span className="flex-1 text-sm">
        {t("classes.claimInstructor.message")}
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
        {t("classes.claimInstructor.action")}
      </Button>
    </Alert>
  )
}

export default ClaimInstructorNotice
