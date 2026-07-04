import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  UserPlus,
  X,
} from "lucide-react"

import Avatar from "@/components/avatar"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useToast } from "@/context/notifications/NotificationProvider"
import { removeMemberFromOrg } from "@/pages/orgMembers/removeMemberFromOrg"
import {
  ClassificationBadge,
  GitHubIdentity,
  initialsFor,
  runInviteMember,
} from "@/pages/orgMembers/memberPresentation"
import type { OrgMemberRow } from "@/util/orgMembers"

// Centered modal showing one org member's details: identity, classification,
// per-classroom access, and the member-level actions (invite an on-roster
// non-member; remove an active member from the org). Replaces the former
// right-side drawer. Driven by an `open` prop over a native <dialog> (matching
// BulkActionsBar / ConfirmModal) so it gets focus-trap, Escape, and an inert
// backdrop for free.
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
  // open/close without the caller juggling conditional rendering.
  row: OrgMemberRow | null
  isSelf: boolean
  isOwner: boolean
  onClose: () => void
  // Called after the member is removed from the org (refresh + optimistic drop).
  onRemoved: () => void
  // Called after an on-roster non-member is invited to the org (refresh only —
  // no classroom membership changed).
  onInvited: () => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const { notify } = useToast()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [inviting, setInviting] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Close and reset the transient confirm/in-flight state in one place. Every
  // close path (the X button, the backdrop, and Escape via onCancel) routes
  // through here, so a reopened modal never shows a stale "confirm remove"
  // panel — no reset-in-effect needed.
  const handleClose = () => {
    if (working) return
    setConfirming(false)
    setInviting(false)
    onClose()
  }

  if (!row) {
    // Keep the <dialog> element mounted (so the open/close effect has a target)
    // but render no body when there's no member selected.
    return <dialog ref={dialogRef} className="modal" aria-hidden />
  }

  const label = row.username || row.email
  // Only non-archived classrooms are actually unenrolled (archived ones can't
  // be; removeMemberFromOrg skips them), so the confirm copy counts those.
  const activeClassrooms = row.classrooms.filter((c) => !c.archived)

  const handleInvite = async () => {
    if (inviting) return
    setInviting(true)
    try {
      await runInviteMember(client, org, row, notify, onInvited, t)
    } finally {
      setInviting(false)
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
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Block Escape while a remove is in flight.
        if (working) {
          event.preventDefault()
          return
        }
        handleClose()
      }}
    >
      <div className="modal-box max-w-lg p-0">
        <div className="flex items-start justify-between gap-4 border-b border-base-300 px-6 py-4">
          <h2 id={titleId} className="text-lg font-bold">
            {t("orgMembers.detailTitle")}
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-square"
            onClick={handleClose}
            disabled={working}
            aria-label={t("common.close")}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <Avatar
            name={row.name || label}
            github={row.username}
            initials={initialsFor(row)}
            subtitle={<GitHubIdentity row={row} />}
          />

          <div className="flex flex-wrap items-center gap-2">
            <ClassificationBadge row={row} isOwner={isOwner} />
            {row.email ? (
              <span className="text-sm text-base-content/70">{row.email}</span>
            ) : null}
          </div>

          <a
            href={`https://github.com/orgs/${org}/people${
              row.username ? `?query=${encodeURIComponent(row.username)}` : ""
            }`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1 text-sm text-primary hover:underline"
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
            {t("orgMembers.manageOnGitHub")}
          </a>

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
                        <span className="badge badge-xs badge-ghost ml-2">
                          {t("orgMembers.archived")}
                        </span>
                      ) : null}
                      {access.state === "unprovisioned" && !access.archived ? (
                        <span
                          className="badge badge-xs badge-warning badge-soft ml-2 gap-1"
                          title={t("orgMembers.unprovisionedAccessTitle")}
                        >
                          <AlertTriangle
                            aria-hidden="true"
                            className="size-2.5"
                          />
                          {t("orgMembers.unprovisionedAccessBadge")}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex items-center gap-2 text-base-content/70">
                      {access.section ? (
                        <span className="badge badge-xs badge-ghost">
                          {access.section}
                        </span>
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
                <button
                  type="button"
                  className="btn btn-primary btn-sm mt-3"
                  disabled={inviting}
                  onClick={() => void handleInvite()}
                >
                  {inviting ? (
                    <>
                      <span
                        className="loading loading-spinner loading-xs"
                        aria-hidden="true"
                      />
                      {t("orgMembers.inviting")}
                    </>
                  ) : (
                    <>
                      <UserPlus aria-hidden="true" className="size-4" />
                      {t("orgMembers.inviteToOrg")}
                    </>
                  )}
                </button>
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
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={working}
                  onClick={() => setConfirming(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-error btn-sm"
                  disabled={working}
                  onClick={() => void handleRemove()}
                >
                  {working ? (
                    <>
                      <span
                        className="loading loading-spinner loading-xs"
                        aria-hidden="true"
                      />
                      {t("orgMembers.removing")}
                    </>
                  ) : (
                    t("orgMembers.removeFromOrg")
                  )}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-error btn-outline btn-sm self-start"
              onClick={() => setConfirming(true)}
            >
              {t("orgMembers.removeFromOrg")}
            </button>
          )}
        </div>
      </div>

      <form method="dialog" className="modal-backdrop">
        {/* Backdrop click closes; disabled mid-remove. */}
        <button type="button" onClick={handleClose} disabled={working}>
          {t("common.close")}
        </button>
      </form>
    </dialog>
  )
}

export default MemberDetailModal
