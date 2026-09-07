import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button, Checkbox } from "@/components/ui"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  linkRosterRowToMember,
  removeUnlinkedRows,
  unlinkedRowRef,
  UnlinkedRowNotFoundError,
  UnlinkedRowAmbiguousError,
  MemberNotActiveError,
  MemberAlreadyOnRosterError,
  type DirectoryMember,
} from "@/domain/students"
import { getErrorMessage } from "@/github-core/errorMessage"
import { nameFromParts } from "@/util/students"
import type { TeamRosterRow } from "@/util/teamRoster"
import MemberLinkPicker, {
  type OrgPoolStatus,
} from "@/pages/students/MemberLinkPicker"

// The member modal's unlinked-row reconciliation section: link the row to an
// org member, or remove it. The picker offers only unclaimed active members;
// the actual link re-proves everything at commit time (domain guards). Owns
// the picker/confirm state, so the parent remounts it (via `key`) on open or
// row-identity change instead of hand-resetting each field.
const UnlinkedRowSection = ({
  org,
  classroom,
  row,
  linkCandidates,
  orgLinkCandidates,
  orgPoolStatus,
  busy,
  onWorkingChange,
  onChanged,
  onClose,
  onError,
}: {
  org: string
  classroom: string
  row: TeamRosterRow
  // Directory members the link picker may offer (the parent already excludes
  // members claiming another roster row).
  linkCandidates: DirectoryMember[]
  // The opt-in widening behind the toggle: the classroom pool plus every
  // other active org member (same claimed-row exclusion). Deliberately not
  // the default — a shared org contains other teachers' members.
  orgLinkCandidates: DirectoryMember[]
  // "unavailable" (member list unreadable) hides the toggle entirely.
  orgPoolStatus: OrgPoolStatus
  // The modal-wide in-flight guard — any pending write disables these actions.
  busy: boolean
  // Mirrors this section's in-flight link/remove up, so the parent modal can
  // block close (Escape/backdrop) while the write is pending.
  onWorkingChange: (working: boolean) => void
  onChanged: (rowKey: string) => void
  onClose: () => void
  onError: (rowKey: string, message: string) => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  // The link picker's text/open/selection, the in-flight link/remove, and the
  // remove confirmation.
  const [linkQuery, setLinkQuery] = useState("")
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkTarget, setLinkTarget] = useState<DirectoryMember | null>(null)
  const [linking, setLinking] = useState(false)
  const [includeOrgMembers, setIncludeOrgMembers] = useState(false)
  const [removingRow, setRemovingRow] = useState(false)
  const [confirmingRemoveRow, setConfirmingRemoveRow] = useState(false)

  const working = linking || removingRow
  // Reset on unmount too: a success closes the modal while `working` is still
  // true for that render, so the parent would otherwise never see the trailing
  // false (same shape as EditStudentForm's onSubmittingChange).
  useEffect(() => {
    onWorkingChange(working)
    return () => onWorkingChange(false)
  }, [working, onWorkingChange])

  const displayName =
    nameFromParts(row.first_name, row.last_name) || row.username || row.email

  // Typed domain errors -> teacher-actionable copy; anything else falls back
  // to the generic link failure with the raw detail.
  const linkErrorMessage = (err: unknown): string => {
    if (err instanceof UnlinkedRowNotFoundError)
      return t("students.linkRowGone", { label: displayName })
    if (err instanceof UnlinkedRowAmbiguousError)
      return t("students.linkRowAmbiguous", { label: displayName })
    if (err instanceof MemberNotActiveError)
      return t("students.linkMemberNotActive", { login: err.login })
    if (err instanceof MemberAlreadyOnRosterError)
      return t("students.linkMemberClaimed", { login: err.login })
    return t("students.linkFailed", {
      label: displayName,
      error: getErrorMessage(err),
    })
  }

  const handleLink = async () => {
    if (linking || !linkTarget) return
    setLinking(true)
    try {
      const result = await linkRosterRowToMember(client, {
        org,
        classroom,
        rowRef: unlinkedRowRef(row),
        member: { id: linkTarget.id, login: linkTarget.login },
      })
      if (result.teamAdd !== "ok") {
        // Linked, but not on the classroom team yet — the row now renders as
        // needs-attention, whose assign action is the retry.
        onError(
          row.key,
          t("students.linkTeamAddFailed", { login: linkTarget.login }),
        )
      }
      onChanged(row.key)
      onClose()
    } catch (err) {
      onError(row.key, linkErrorMessage(err))
    } finally {
      setLinking(false)
    }
  }

  const handleRemoveRow = async () => {
    if (removingRow) return
    setRemovingRow(true)
    try {
      const result = await removeUnlinkedRows(client, {
        org,
        classroom,
        rowRefs: [unlinkedRowRef(row)],
      })
      if (result.removed === 0) {
        onError(row.key, t("students.linkRowGone", { label: displayName }))
        return
      }
      onChanged(row.key)
      onClose()
    } catch (err) {
      onError(
        row.key,
        t("students.removeRowFailed", {
          label: displayName,
          error: getErrorMessage(err),
        }),
      )
    } finally {
      setRemovingRow(false)
      setConfirmingRemoveRow(false)
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-box border border-base-300 bg-base-200/40 p-4">
      <p className="text-sm text-base-content/80">{t("students.linkIntro")}</p>
      <div className="flex items-start gap-2">
        <MemberLinkPicker
          id="roster-link-member"
          className="grow"
          label={t("students.linkMemberLabel")}
          placeholder={t("students.linkMemberPlaceholder")}
          emptyState={
            !includeOrgMembers && orgPoolStatus !== "unavailable"
              ? t("students.linkMemberEmptyWiden")
              : t("students.linkMemberEmpty")
          }
          items={includeOrgMembers ? orgLinkCandidates : linkCandidates}
          notInClassroomLabel={
            includeOrgMembers ? t("students.linkNotInClassroom") : undefined
          }
          value={linkQuery}
          onInputChange={(value) => {
            setLinkQuery(value)
            setLinkTarget(null)
          }}
          open={linkOpen}
          onOpenChange={setLinkOpen}
          onSelect={(m) => {
            setLinkTarget(m)
            setLinkQuery(m.login)
          }}
        />
        <Button
          variant="primary"
          loading={linking}
          loadingLabel={t("common.working")}
          disabled={busy || !linkTarget}
          onClick={() => void handleLink()}
        >
          {t("students.linkMemberAction")}
        </Button>
      </div>
      {orgPoolStatus !== "unavailable" ? (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={includeOrgMembers}
            disabled={busy || linking}
            onChange={(e) => {
              const next = e.currentTarget.checked
              setIncludeOrgMembers(next)
              // Narrowing back can strand an org-only pick the classroom pool
              // no longer offers; drop it rather than link something unseen.
              if (
                !next &&
                linkTarget &&
                !linkCandidates.some((m) => m.id === linkTarget.id)
              ) {
                setLinkTarget(null)
                setLinkQuery("")
              }
            }}
          />
          <span>
            {t("students.linkIncludeOrgMembers")}
            {includeOrgMembers && orgPoolStatus === "loading" ? (
              <span className="block text-xs text-base-content/60">
                {t("students.linkOrgMembersLoading")}
              </span>
            ) : null}
          </span>
        </label>
      ) : null}
      {confirmingRemoveRow ? (
        <div className="flex flex-col gap-3 rounded-box border border-error/30 bg-error/5 p-4 text-sm">
          <p className="text-base-content/80">
            {t("students.confirmRemoveRowBody", { label: displayName })}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={removingRow}
              onClick={() => setConfirmingRemoveRow(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="error"
              size="sm"
              loading={removingRow}
              loadingLabel={t("common.working")}
              disabled={removingRow}
              onClick={() => void handleRemoveRow()}
            >
              {t("students.removeRowAction")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="text-error hover:bg-error/10"
            disabled={busy}
            onClick={() => setConfirmingRemoveRow(true)}
          >
            {t("students.removeRowAction")}
          </Button>
        </div>
      )}
    </section>
  )
}

export default UnlinkedRowSection
