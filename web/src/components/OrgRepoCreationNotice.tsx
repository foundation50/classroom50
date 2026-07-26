import { AlertTriangle, Settings } from "lucide-react"
import { Trans, useTranslation } from "react-i18next"

import { Alert, EmphasisLtr, RouterButton } from "@/components/ui"
import useOrgRepoCreationWarning from "@/hooks/useOrgRepoCreationWarning"
import { memberPrivilegesUrl } from "@/orgPolicy/desiredState"

// Warns a teacher that the org will refuse student repo creation, before a
// student hits the accept-time 403. A warning rather than an error: the org may
// be mid-setup, and nothing is broken yet.
//
// The primary action is the in-app organization-setup re-run, not the GitHub
// toggle: hand-fixing one checkbox leaves the rest of the audited lockdown
// unapplied. The manual link stays as the secondary path, and the copy keeps the
// enterprise-override caveat because the re-run can silently no-op.
//
// This is the assignment-scoped view of the same signal OrgPreflightNotice shows
// owners on ClassesPage — keep the two copies in step.
//
// The org read lives inside this component deliberately: mounting it only inside
// a staff-gated subtree is what keeps a student from both seeing the warning and
// firing a read they could never act on. Renders nothing when the setting is
// enabled, unreadable (GitHub omits member-privilege fields for non-admins), or
// still loading.
export const OrgRepoCreationNotice = ({
  org,
  className = "mb-6",
}: {
  org: string | undefined
  className?: string
}) => {
  const { t } = useTranslation()
  const warning = useOrgRepoCreationWarning(org)

  if (!org || !warning.show) return null

  return (
    <Alert
      tone="warning"
      className={`flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between ${className}`}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="text-sm">
          <Trans
            i18nKey={
              warning.field === "master"
                ? "components.notices.orgRepoCreation.master"
                : "components.notices.orgRepoCreation.private"
            }
            values={{ org }}
            components={{
              org: <EmphasisLtr />,
              memberPrivileges: (
                <a
                  className="link"
                  href={memberPrivilegesUrl(org)}
                  target="_blank"
                  rel="noreferrer"
                />
              ),
            }}
          />
        </span>
      </div>
      <RouterButton
        to="/$org/settings"
        params={{ org }}
        variant="warning"
        size="sm"
        className="whitespace-nowrap sm:shrink-0"
      >
        <Settings className="size-4" aria-hidden="true" />
        {t("components.notices.orgRepoCreation.action")}
      </RouterButton>
    </Alert>
  )
}

export default OrgRepoCreationNotice
