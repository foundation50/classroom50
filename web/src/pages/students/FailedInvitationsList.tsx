import { useTranslation } from "react-i18next"
import { Alert, Button } from "@/components/ui"
import type { GitHubOrgInvitation } from "@/github-core/types"

// Failed/expired invitations (owner-only). GitHub couldn't deliver these, so
// they need a re-invite or dismissal — surfaced here since they never appear as
// roster rows. A login-less, email-less invite can't be re-issued (dismiss-only).
export const FailedInvitationsList = ({
  failedInvitations,
  actionsDisabled,
  onReinvite,
  onDismiss,
}: {
  failedInvitations: GitHubOrgInvitation[]
  actionsDisabled: boolean
  onReinvite: (inv: GitHubOrgInvitation) => void
  onDismiss: (inv: GitHubOrgInvitation) => void
}) => {
  const { t } = useTranslation()
  return (
    <Alert tone="warning" className="flex-col items-stretch gap-2">
      <span className="text-sm font-medium">
        {t("students.failedInvitesTitle", { count: failedInvitations.length })}
      </span>
      <ul className="flex flex-col divide-y divide-warning/20">
        {failedInvitations.map((inv) => {
          const who = inv.login || inv.email || String(inv.id)
          return (
            <li
              key={inv.id}
              className="flex items-center justify-between gap-3 py-1.5"
            >
              <span className="min-w-0 text-sm">
                <span className="font-mono">{who}</span>
                {inv.failed_reason ? (
                  <span className="text-base-content/60">
                    {" "}
                    — {inv.failed_reason}
                  </span>
                ) : null}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                {inv.login || inv.email ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={actionsDisabled}
                    onClick={() => onReinvite(inv)}
                  >
                    {t("students.reinvite")}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={actionsDisabled}
                  onClick={() => onDismiss(inv)}
                >
                  {t("students.dismiss")}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </Alert>
  )
}
