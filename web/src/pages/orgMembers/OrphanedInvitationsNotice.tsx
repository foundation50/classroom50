import { useId, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, Badge, Button, Collapse, MonoLtr } from "@/components/ui"
import { formatInvitedAt } from "@/util/formatDate"
import type { OrphanedFailedInvitation } from "@/util/orgMembers"

// The org-wide leftovers: failed/expired invitations GitHub still lists that no
// classroom roster or member explains (see orphanedFailedInvitations). Nothing
// on any roster can re-invite them, so the only action is dismissal, and only
// by hand: an owner-sent invitation unrelated to Classroom 50 looks the same.
// Collapsed to a one-line summary by default; the list scrolls so a long
// backlog can't push the page around.
export const OrphanedInvitationsNotice = ({
  orphans,
  busy,
  onDismiss,
  onDismissAll,
}: {
  orphans: OrphanedFailedInvitation[]
  busy: boolean
  onDismiss: (invitationId: number) => void
  onDismissAll: () => void
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (orphans.length === 0) return null

  return (
    <Alert tone="warning" className="flex-col items-stretch gap-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {t("orgMembers.orphanedInvitesTitle", { count: orphans.length })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((o) => !o)}
          >
            {open
              ? t("orgMembers.orphanedInvitesHide")
              : t("orgMembers.orphanedInvitesView")}
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={onDismissAll}
          >
            {t("orgMembers.orphanedInvitesDismissAll")}
          </Button>
        </div>
      </div>
      <p className="text-base-content/80">
        {t("orgMembers.orphanedInvitesBody")}
      </p>
      <Collapse open={open}>
        <ul
          id={listId}
          className="max-h-64 divide-y divide-warning/20 overflow-y-auto rounded-box border border-warning/30 bg-base-100/60"
        >
          {orphans.map(({ invitation, ref }) => {
            const who = invitation.login
              ? `@${invitation.login}`
              : (invitation.email ?? String(invitation.id))
            const when = formatInvitedAt(ref.failed_at)
            return (
              <li
                key={invitation.id}
                className="flex items-center justify-between gap-3 px-3 py-1.5"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <MonoLtr className="truncate">{who}</MonoLtr>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-base-content/60">
                    <Badge size="xs" tone="error">
                      {ref.kind === "expired"
                        ? t("orgMembers.orphanedInviteExpired")
                        : t("orgMembers.orphanedInviteFailed")}
                    </Badge>
                    {when ? <span>{when}</span> : null}
                    {ref.kind === "failed" && ref.reason ? (
                      <span className="truncate">{ref.reason}</span>
                    ) : null}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => onDismiss(invitation.id)}
                >
                  {t("orgMembers.orphanedInvitesDismiss")}
                </Button>
              </li>
            )
          })}
        </ul>
      </Collapse>
    </Alert>
  )
}

export default OrphanedInvitationsNotice
