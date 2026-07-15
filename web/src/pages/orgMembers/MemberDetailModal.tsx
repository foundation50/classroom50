import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { AlertTriangle, ChevronRight, UserPlus, X } from "lucide-react"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { Badge, Button, Modal } from "@/components/ui"
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
  row,
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
  const titleId = useId()
  const [confirming, setConfirming] = useState(false)
  const [confirmingInvite, setConfirmingInvite] = useState(false)
  const [working, setWorking] = useState(false)
  const [inviting, setInviting] = useState(false)

  // Close and reset transient confirm/in-flight state in one place. Every close
  // path (X, backdrop, Escape via onCancel) routes here, so a reopened modal
  // never shows a stale "confirm remove" panel — no reset-in-effect needed.
  const handleClose = () => {
    if (working) return
    setConfirming(false)
    setConfirmingInvite(false)
    setInviting(false)
    onClose()
  }

  if (!row) {
    // No selected member: render nothing (the modal is closed in this state).
    return <Modal open={open} onClose={handleClose} aria-labelledby={titleId} />
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

  return (
    <Modal
      open={open}
      onClose={handleClose}
      closeDisabled={working}
      hideCloseButton
      size="lg"
      boxClassName="p-0"
      aria-labelledby={titleId}
    >
      <div className="flex items-start justify-between gap-4 border-b border-base-300 px-6 py-4">
        <h2 id={titleId} className="text-lg font-bold">
          {t("orgMembers.detailTitle")}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          onClick={handleClose}
          disabled={working}
          aria-label={t("common.close")}
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-4 px-6 py-5">
        <MemberDetailHeader row={row} org={org} />

        <div className="flex flex-wrap items-center gap-2">
          <ClassificationBadge row={row} isOwner={isOwner} />
          {row.email ? (
            <span className="text-sm text-base-content/70">{row.email}</span>
          ) : null}
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
                      <Badge size="xs" ghost className="ml-2">
                        {t("orgMembers.archived")}
                      </Badge>
                    ) : null}
                    {access.state === "unprovisioned" && !access.archived ? (
                      <Badge
                        size="xs"
                        tone="warning"
                        className="ml-2 gap-1"
                        title={t("orgMembers.unprovisionedAccessTitle")}
                      >
                        <AlertTriangle
                          aria-hidden="true"
                          className="size-2.5"
                        />
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
                    <ChevronRight
                      aria-hidden="true"
                      className="size-4 text-base-content/30 transition-transform duration-150 group-hover/cls:translate-x-0.5 group-hover/cls:text-base-content/70"
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
                {t("orgMembers.notMemberPrefix", { label })}{" "}
                <span className="font-semibold">
                  {t("orgMembers.notMemberEmphasis")}
                </span>
                {t("orgMembers.notMemberSuffix")}
              </p>
              <Button
                variant="primary"
                size="sm"
                className="mt-3"
                disabled={inviting}
                hidden={confirmingInvite}
                onClick={() => setConfirmingInvite(true)}
              >
                <UserPlus aria-hidden="true" className="size-4" />
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
                          <UserPlus aria-hidden="true" className="size-4" />
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
              {t("orgMembers.notMemberNoId")}
            </div>
          )
        ) : confirming ? (
          <div className="rounded-box border border-error/30 bg-error/5 p-4 text-sm">
            <p className="text-base-content/80">
              {activeClassrooms.length > 0 ? (
                <>
                  {t("orgMembers.confirmUnenrollPrefix", { label })}{" "}
                  <span className="font-semibold">
                    {t("orgMembers.confirmClassroomCount", {
                      count: activeClassrooms.length,
                    })}
                  </span>{" "}
                  {t("orgMembers.confirmUnenrollMid", {
                    classrooms: activeClassrooms
                      .map((c) => c.classroom)
                      .join(", "),
                  })}{" "}
                  <span className="font-semibold">{org}</span>{" "}
                  {t("orgMembers.confirmUnenrollSuffix")}
                </>
              ) : (
                <>
                  {t("orgMembers.confirmRemovePrefix", { label })}{" "}
                  <span className="font-semibold">{org}</span>{" "}
                  {t("orgMembers.confirmRemoveSuffix")}
                </>
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
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="btn-error self-start"
            onClick={() => setConfirming(true)}
          >
            {t("orgMembers.removeFromOrg")}
          </Button>
        )}
      </div>
    </Modal>
  )
}

export default MemberDetailModal
