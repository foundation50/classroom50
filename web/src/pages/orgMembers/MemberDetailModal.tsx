import { useEffect, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import {
  AlertIcon,
  ChevronRightIcon,
  PersonAddIcon,
} from "@/components/ui/icons"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { Badge, Button, EmphasisLtr, Modal, rtlFlip } from "@/components/ui"
import { GitHubLink } from "@/components/GitHubLink"
import { removeMemberFromOrg } from "@/domain/orgMembers/removeMemberFromOrg"
import {
  ClassificationBadge,
  runInviteMember,
} from "@/pages/orgMembers/memberPresentation"
import MemberDetailHeader from "@/components/memberList/MemberDetailHeader"
import type { OrgMemberRow } from "@/util/orgMembers"

// Centered modal showing one org member's details: identity, classification,
// per-classroom access, and member-level actions (invite an on-roster
// non-member; remove an active member). Driven by an `open` prop over a native
// <dialog> (like BulkActionsBar / ConfirmModal) for free focus-trap, Escape, and
// an inert backdrop.
const MemberDetailModal = ({
  open,
  org,
  row: rowProp,
  isSelf,
  isOwner,
  onClose,
  onRemoved,
  onInvited,
}: {
  open: boolean
  org: string
  // The member to show. Null is tolerated so the modal can stay mounted across
  // open/close without conditional rendering by the caller.
  row: OrgMemberRow | null
  isSelf: boolean
  isOwner: boolean
  onClose: () => void
  // Called after the member is removed from the org (refresh + optimistic drop).
  onRemoved: () => void
  // Called after an on-roster non-member is invited (refresh only — no classroom
  // membership changed).
  onInvited: () => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const { notify } = useToast()
  const [confirming, setConfirming] = useState(false)
  const [confirmingInvite, setConfirmingInvite] = useState(false)
  const [working, setWorking] = useState(false)
  const [inviting, setInviting] = useState(false)

  // Retain the last non-null row so the modal keeps rendering its real content
  // through the close animation. Without this, clearing the selection swaps in
  // a structurally-empty <Modal> for the frames the dialog is still fading out,
  // collapsing it to just the title. `open` still drives the actual close.
  const [lastRow, setLastRow] = useState<OrgMemberRow | null>(null)
  useEffect(() => {
    if (rowProp) setLastRow(rowProp)
  }, [rowProp])
  const row = rowProp ?? lastRow

  // Reset transient confirm/in-flight state when OPENING (a close-time reset
  // would collapse an open confirm panel under the dialog's fade-out), so a
  // reopened modal never shows a stale "confirm remove" panel.
  useEffect(() => {
    if (!open) return
    setConfirming(false)
    setConfirmingInvite(false)
    setInviting(false)
  }, [open])

  const handleClose = () => {
    if (working) return
    onClose()
  }

  if (!row) {
    // Never had a row (initial mount, closed): nothing to show.
    return (
      <Modal
        open={open}
        onClose={handleClose}
        title={t("orgMembers.detailTitle")}
      />
    )
  }

  const label = row.username || row.email
  // Only non-archived classrooms are unenrolled (removeMemberFromOrg skips
  // archived), so the confirm copy counts those.
  const activeClassrooms = row.classrooms.filter((c) => !c.archived)

  const handleInvite = async () => {
    if (inviting) return
    setInviting(true)
    try {
      await runInviteMember(client, org, row, notify, onInvited, t)
    } finally {
      setInviting(false)
      setConfirmingInvite(false)
    }
  }

  const handleRemove = async () => {
    if (working) return
    setWorking(true)
    try {
      const result = await removeMemberFromOrg(client, { org, row }, t)
      if (result.warnings.length > 0) {
        notify({
          tone: "warning",
          durationMs: 8000,
          message: result.warnings.join(" "),
        })
      } else {
        notify({
          tone: "success",
          durationMs: 6000,
          message: result.unenrolledClassrooms.length
            ? t("orgMembers.removedWithUnenroll", {
                label,
                org,
                count: result.unenrolledClassrooms.length,
              })
            : t("orgMembers.removed", { label, org }),
        })
      }
      onRemoved()
    } catch (err) {
      notify({
        tone: "error",
        message: t("orgMembers.removeFailed", {
          label,
          reason:
            err instanceof Error ? err.message : t("orgMembers.somethingWrong"),
        }),
      })
    } finally {
      setWorking(false)
      setConfirming(false)
    }
  }

  // The destructive trigger lives in the footer; the inline confirm panel it
  // opens stays in the body (a nested <dialog> can't stack on an open one).
  const canRemove = !isSelf && row.isMember

  return (
    <Modal
      open={open}
      onClose={handleClose}
      closeDisabled={working}
      size="lg"
      title={t("orgMembers.detailTitle")}
      footer={
        <>
          <GitHubLink
            href={`https://github.com/orgs/${org}/people${
              row.username ? `?query=${encodeURIComponent(row.username)}` : ""
            }`}
            label={t("orgMembers.manageOnGitHub")}
            className="me-auto self-center"
          />
          <Button variant="ghost" size="sm" onClick={handleClose}>
            {t("common.close")}
          </Button>
          {canRemove && (
            <Button
              variant="error"
              size="sm"
              disabled={working || confirming}
              onClick={() => setConfirming(true)}
            >
              {t("orgMembers.removeFromOrg")}
            </Button>
          )}
        </>
      }
    >
      <div className="mt-4 flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <MemberDetailHeader row={row} />
          <ClassificationBadge row={row} isOwner={isOwner} />
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">
            {t("orgMembers.classroomAccess")}
          </h3>
          {row.classrooms.length === 0 ? (
            <p className="text-sm text-base-content/70">
              {t("orgMembers.noRoster")}
            </p>
          ) : (
            <ul className="divide-y divide-base-300 rounded-box border border-base-300">
              {row.classrooms.map((access) => (
                <Link
                  key={access.classroom}
                  to="/$org/$classroom"
                  params={{ org, classroom: access.classroom }}
                  onClick={onClose}
                  className="group/cls flex items-center justify-between px-3 py-2 text-sm first:rounded-t-box last:rounded-b-box cursor-pointer transition-[background-color,transform,box-shadow] duration-150 ease-out hover:bg-base-200 hover:-translate-y-px hover:shadow-sm motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:hover:shadow-none"
                >
                  <span className="font-medium">
                    {access.classroom}
                    {access.archived ? (
                      <Badge size="xs" ghost className="ms-2">
                        {t("orgMembers.archived")}
                      </Badge>
                    ) : null}
                    {access.state === "unprovisioned" && !access.archived ? (
                      <Badge
                        size="xs"
                        tone="warning"
                        className="ms-2 gap-1"
                        title={t("orgMembers.unprovisionedAccessTitle")}
                      >
                        <AlertIcon aria-hidden="true" className="size-2.5" />
                        {t("orgMembers.unprovisionedAccessBadge")}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2 text-base-content/70">
                    {access.section ? (
                      <Badge size="xs" ghost>
                        {access.section}
                      </Badge>
                    ) : null}
                    <ChevronRightIcon
                      aria-hidden="true"
                      className={`size-4 text-base-content/30 transition-transform duration-150 ltr:group-hover/cls:translate-x-0.5 rtl:group-hover/cls:-translate-x-0.5 group-hover/cls:text-base-content/70 ${rtlFlip}`}
                    />
                  </span>
                </Link>
              ))}
            </ul>
          )}
        </div>

        {isSelf ? (
          <div className="rounded-box border border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
            {t("orgMembers.selfNotice")}
          </div>
        ) : !row.isMember ? (
          row.github_id ? (
            <div className="rounded-box border border-warning/30 bg-warning/5 p-4 text-sm">
              <p className="text-base-content/80">
                <Trans
                  i18nKey="orgMembers.notMember"
                  values={{ label }}
                  components={{ emphasis: <span className="font-semibold" /> }}
                />
              </p>
              <Button
                variant="primary"
                size="sm"
                className="mt-3"
                disabled={inviting}
                hidden={confirmingInvite}
                onClick={() => setConfirmingInvite(true)}
              >
                <PersonAddIcon aria-hidden="true" className="size-4" />
                {t("orgMembers.inviteToOrg")}
              </Button>
              {confirmingInvite ? (
                <div className="mt-3 flex flex-col gap-3 border-t border-warning/30 pt-3">
                  <p className="text-base-content/80">
                    {t("orgMembers.confirmInviteBody", { label, org })}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={inviting}
                      onClick={() => setConfirmingInvite(false)}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={inviting}
                      loadingLabel={t("orgMembers.inviting")}
                      disabled={inviting}
                      onClick={() => void handleInvite()}
                    >
                      {inviting ? (
                        t("orgMembers.inviting")
                      ) : (
                        <>
                          <PersonAddIcon
                            aria-hidden="true"
                            className="size-4"
                          />
                          {t("orgMembers.inviteToOrg")}
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-box border border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
              {t(
                row.classification === "invitation-pending"
                  ? "orgMembers.invitePendingNotice"
                  : "orgMembers.notMemberNoId",
              )}
            </div>
          )
        ) : confirming ? (
          <div className="rounded-box border border-error/30 bg-error/5 p-4 text-sm">
            <p className="text-base-content/80">
              {activeClassrooms.length > 0 ? (
                <Trans
                  i18nKey="orgMembers.confirmUnenroll"
                  count={activeClassrooms.length}
                  values={{
                    label,
                    org,
                    classrooms: activeClassrooms
                      .map((c) => c.classroom)
                      .join(", "),
                  }}
                  components={{
                    count: <span className="font-semibold" />,
                    org: <EmphasisLtr />,
                  }}
                />
              ) : (
                <Trans
                  i18nKey="orgMembers.confirmRemove"
                  values={{ label, org }}
                  components={{
                    org: <EmphasisLtr />,
                  }}
                />
              )}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={working}
                onClick={() => setConfirming(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="error"
                size="sm"
                loading={working}
                loadingLabel={t("orgMembers.removing")}
                disabled={working}
                onClick={() => void handleRemove()}
              >
                {working
                  ? t("orgMembers.removing")
                  : t("orgMembers.removeFromOrg")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

export default MemberDetailModal
