import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ExternalLink,
  Pencil,
  Send,
  UserMinus,
  UserPlus,
  X,
  XCircle,
} from "lucide-react"

import { useMutation } from "@tanstack/react-query"

import Avatar from "@/components/avatar"
import GitHub from "@/assets/github.svg?react"
import EditStudentForm from "@/pages/students/EditStudentForm"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  assignRosterMemberRole,
  applyClassroomRoleChange,
  inviteRosterStudents,
  resolveTeamIdForRoleRead,
  unenrollStudent,
  type StudentCsvRow,
} from "@/domain/students"
import {
  resendOrgInvitation,
  cancelOrgInvitation,
} from "@/github-core/mutations"
import { getErrorMessage } from "@/github-core/errorMessage"
import { nameFromParts, parseGitHubId } from "@/util/students"
import { rosterRowInitials } from "@/util/memberRow"
import {
  githubOrgRoleForRole,
  rowToStudent,
  sortRolesByRank,
  type ClassroomRole,
  type TeamRosterRow,
} from "@/util/teamRoster"
import {
  hasStudentEnrollment,
  STATE_BADGE_TONE,
  STATE_LABEL_KEY,
} from "@/util/rosterRoles"
import { Badge, Button, Modal, Select } from "@/components/ui"

// Roster-owned detail modal (single native <dialog>), opened by clicking a
// roster row. Shares the identity header with the Org Members modal; everything
// below is classroom-scoped and gated by row.state:
//   enrolled -> edit metadata + unenroll
//   pending  -> resend invite + unenroll (cancels the invite); no edit
//   needs_attention_in_org -> assign a role (adds to the chosen team)
//   needs_attention_not_in_org -> invite to the organization
//
// The modal performs the writes but hands results back to the parent (which
// owns the roster/invite caches and the per-row warnings map), mirroring the
// pre-refactor inline actions.
const RosterMemberModal = ({
  open,
  org,
  classroom,
  teamSlugByRole,
  row: rowProp,
  canManage = true,
  isSelf = false,
  onClose,
  onSaved,
  onUnenrolled,
  onResent,
  onCanceled,
  onChanged,
  onError,
}: {
  open: boolean
  org: string
  classroom: string
  // Resolved team slug per role, so each role a member actually holds links to
  // its real team (student -> classroom team, instructor/ta -> the staff team)
  // instead of assuming everyone is on the student team.
  teamSlugByRole: Record<ClassroomRole, string>
  // Nullable so the <dialog> can stay mounted across open/close.
  row: TeamRosterRow | null
  // Whether the viewer can perform owner-scoped membership writes (invite,
  // resend, cancel, unenroll, role change). False for a non-owner (pending is
  // hidden), so those actions are hidden with an explanatory note rather than
  // rendered as buttons that silently no-op.
  canManage?: boolean
  // True when this row IS the signed-in viewer. A viewer can't change their own
  // role here: demoting yourself off instructor would revoke your own org-owner
  // access mid-change (the mutation refuses it too — this hides the control so
  // there's no dead action). Mirrors the self-exclusion on bulk select/unenroll.
  isSelf?: boolean
  onClose: () => void
  onSaved: (rowKey: string, updated: StudentCsvRow) => void
  onUnenrolled: (rowKey: string, teamWarning?: string) => void
  onResent: (rowKey: string) => void
  // A pending invite was cancelled — the parent drops the row's warning and
  // refetches so the now-uninvited person leaves the roster.
  onCanceled: (rowKey: string) => void
  // A needs-attention row was resolved (assigned a role, or invited) — the
  // parent refetches the roster + invalidates invite/team caches so the row
  // moves to enrolled/pending.
  onChanged: (rowKey: string) => void
  onError: (rowKey: string, message: string) => void
}) => {
  const { t } = useTranslation()
  const client = useGitHubClient()
  const titleId = useId()
  const [confirmingUnenroll, setConfirmingUnenroll] = useState(false)
  const [confirmingResend, setConfirmingResend] = useState(false)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [editingProfile, setEditingProfile] = useState(false)
  const [working, setWorking] = useState(false)
  const [resending, setResending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [changingRole, setChangingRole] = useState(false)
  // The role selected in the enrolled-row role dropdown (null = matches current,
  // no pending change). Instructor target requires the owner-grant confirmation.
  const [pendingRole, setPendingRole] = useState<ClassroomRole | null>(null)
  const [roleOwnerConfirmed, setRoleOwnerConfirmed] = useState(false)

  const unenrollMutation = useMutation({
    mutationFn: (student: ReturnType<typeof rowToStudent>) =>
      unenrollStudent(client, { org, classroom, student }),
  })

  // `resending` covers an in-flight invite/resend; folding it into `busy` keeps
  // the modal non-closeable (button, backdrop, Escape) while a write is pending,
  // matching the unenroll (`working`) guard. Without it, closing or switching
  // rows mid-invite would let the captured-row promise apply onResent/onError/
  // onClose to a stale student.
  const busy =
    working ||
    submitting ||
    resending ||
    cancelling ||
    resolving ||
    changingRole

  const handleClose = () => {
    if (busy) return
    setConfirmingUnenroll(false)
    setConfirmingResend(false)
    setConfirmingCancel(false)
    setPendingRole(null)
    setRoleOwnerConfirmed(false)
    setEditingProfile(false)
    onClose()
  }

  // Retain the last non-null row so the modal keeps rendering its real content
  // through the close animation. Without this, clearing the selection swaps in a
  // structurally-empty <Modal> for the frames the dialog is still fading out,
  // flashing a tiny empty box. `open` (from the parent's Boolean(selected)) still
  // drives the actual close.
  const [lastRow, setLastRow] = useState<TeamRosterRow | null>(null)
  useEffect(() => {
    if (rowProp) setLastRow(rowProp)
  }, [rowProp])

  // Reset per-row draft state when the modal's row identity changes without an
  // intervening close (parent re-points the selection, or a refetch re-resolves
  // the same key to shifted data). Done during render (not an effect) so a
  // staged role change — and its owner-grant confirmation, the sole guard
  // before granting org OWNER — can never carry onto the next member and apply
  // against a base role the teacher never re-evaluated.
  const [draftRowKey, setDraftRowKey] = useState<string | null>(
    rowProp?.key ?? null,
  )
  if (rowProp && rowProp.key !== draftRowKey) {
    setDraftRowKey(rowProp.key)
    setPendingRole(null)
    setRoleOwnerConfirmed(false)
    setConfirmingResend(false)
    setConfirmingCancel(false)
    setConfirmingUnenroll(false)
    setEditingProfile(false)
  }

  const row = rowProp ?? lastRow

  if (!row) {
    // Never had a row (initial mount, closed): nothing to show.
    return <Modal open={open} onClose={handleClose} aria-labelledby={titleId} />
  }

  const student = rowToStudent(row)
  // A staff-only row is an instructor/TA with no student enrollment. Unenroll
  // (dropping a student-team membership) doesn't apply to them — that's the one
  // student-only action (see canUnenroll). Profile metadata IS editable for them
  // (see canEdit): syncRosterFromTeam writes a roster.csv row per team member.
  // A person who is BOTH staff and a student keeps the student actions (they do
  // have a student enrollment), so gate on the student enrollment, not
  // "student is the sole role" (hasStudentEnrollment — shared with the bulk gate).
  const staffOnly = !hasStudentEnrollment(row)
  // Profile metadata (name / email / section) is teacher-supplied and editable
  // for any enrolled member with a roster.csv row — including a staff-only
  // instructor/TA, since syncRosterFromTeam writes a (blank-metadata) row for
  // every team member for the teacher to fill in. It only gates out `pending`
  // rows (no roster row yet — the invite hasn't been accepted) and rows without
  // a resolvable roster identity. Unenroll stays student-only (see canUnenroll);
  // editing profile fields is not the same as unenrolling.
  const canEdit = row.state !== "pending" && Boolean(row.username)
  const displayName =
    nameFromParts(row.first_name, row.last_name) || row.username || row.email
  const displayInitials = rosterRowInitials(row)
  const label = row.username || row.email
  const canResend =
    canManage && row.state === "pending" && Boolean(row.github_id)
  // Cancelling a pending invite needs its org-invitation id (set on pending
  // rows). Available even for an email-only pending invite (no github_id), so
  // gate on the id, not github_id.
  const canCancel =
    canManage &&
    row.state === "pending" &&
    typeof row.invitation_id === "number"
  const needsRole = canManage && row.state === "needs_attention_in_org"
  const needsInvite = canManage && row.state === "needs_attention_not_in_org"
  // Unenroll drops a roster.csv row + student-team membership — a student-only
  // action. Hidden for a staff-only row (nothing to unenroll from the roster).
  const canUnenroll = canManage && !staffOnly
  // Per-member role change is offered for an ENROLLED (active-team) member with
  // a resolvable username — but NOT for the viewer's own row: demoting yourself
  // off instructor revokes your own org-owner access mid-change (the mutation
  // refuses it), so the control is suppressed with a note rather than shown as a
  // dead action. The dropdown seeds from their primary current role; switching +
  // confirming calls applyClassroomRoleChange (which grants/revokes org owner for
  // an instructor target/demotion).
  const currentRole: ClassroomRole = sortRolesByRank(row.roles)[0] ?? "student"
  const canChangeRole =
    canManage && !isSelf && row.state === "enrolled" && Boolean(row.username)
  // Show the "can't change your own role" note only when a role change would
  // otherwise be offered (an enrolled self row a manager could act on).
  const selfRoleBlocked =
    canManage && isSelf && row.state === "enrolled" && Boolean(row.username)
  const selectedRole = pendingRole ?? currentRole
  const roleChanged = selectedRole !== currentRole
  // Single-sourced with the write mapping: a role grants org owner iff its
  // invite carries the "admin" org role (currently only instructor).
  const roleGrantsOwner = githubOrgRoleForRole(selectedRole) === "admin"
  const canApplyRole = roleChanged && (!roleGrantsOwner || roleOwnerConfirmed)

  const handleAssignRole = async () => {
    if (resolving) return
    const { key, username } = row
    if (!username) {
      onError(key, t("students.assignRoleNoUsername", { label }))
      return
    }
    setResolving(true)
    try {
      const result = await assignRosterMemberRole(client, {
        org,
        classroom,
        username,
        // The roster only assigns the student role; TA/instructor are assigned
        // in classroom Settings (staff management), keeping role-granting in one
        // place and the roster's needs-attention action a simple "enroll".
        role: "student",
      })
      if (result.state === "not-member") {
        onError(key, t("students.assignRoleNotMember", { label }))
        return
      }
      onChanged(key)
      onClose()
    } catch (err) {
      onError(
        key,
        t("students.assignRoleFailed", { label, error: getErrorMessage(err) }),
      )
    } finally {
      setResolving(false)
    }
  }

  const handleInvite = async () => {
    if (resolving) return
    const { key, username, github_id } = row
    if (!username) {
      onError(key, t("students.inviteRosterNoUsername", { label }))
      return
    }
    setResolving(true)
    try {
      const res = await inviteRosterStudents(client, {
        org,
        classroom,
        students: [{ username, github_id }],
      })
      // A failed target sent nothing; a rate-limited (deferred) target also sent
      // nothing. Only a fresh invite or an already-active/pending skip is a real
      // success — otherwise surface it so the teacher retries rather than seeing
      // a false success while the row stays put.
      const failure = res.failed[0]
      if (failure) {
        onError(
          key,
          t("students.inviteRosterFailed", { label, error: failure.message }),
        )
        return
      }
      if (res.deferred.length > 0) {
        onError(key, t("students.inviteRosterDeferred", { label }))
        return
      }
      if (res.invited.length === 0 && res.skipped.length === 0) {
        onError(key, t("students.inviteRosterNoneSent", { label }))
        return
      }
      onChanged(key)
      onClose()
    } catch (err) {
      onError(
        key,
        t("students.inviteRosterFailed", {
          label,
          error: getErrorMessage(err),
        }),
      )
    } finally {
      setResolving(false)
    }
  }

  const handleResend = async () => {
    if (resending) return
    const inviteeId = parseGitHubId(row.github_id)
    if (inviteeId === null || !row.username) {
      onError(
        row.key,
        t("students.resendMissingId", { username: row.username || row.email }),
      )
      return
    }
    setResending(true)
    try {
      // Re-attach the row's team so the re-sent invite lands the invitee on the
      // right team on acceptance (a team-less resend would orphan them).
      const role = sortRolesByRank(row.roles)[0] ?? "student"
      const teamId = await resolveTeamIdForRoleRead(
        client,
        org,
        classroom,
        role,
      )
      await resendOrgInvitation(client, {
        org,
        username: row.username,
        inviteeId,
        invitationId: row.invitation_id,
        teamIds: teamId ? [teamId] : undefined,
        // Re-issue with the same org role as the original invite, so a resend
        // never downgrades a pending instructor from org OWNER.
        role: githubOrgRoleForRole(role),
      })
      onResent(row.key)
      onClose()
    } catch (err) {
      onError(
        row.key,
        t("students.resendFailed", {
          username: row.username || row.email,
          error: getErrorMessage(err),
        }),
      )
    } finally {
      setResending(false)
      setConfirmingResend(false)
    }
  }

  const handleCancelInvite = async () => {
    if (cancelling) return
    const invitationId = row.invitation_id
    if (typeof invitationId !== "number") {
      onError(row.key, t("students.cancelInviteMissingId", { label }))
      return
    }
    setCancelling(true)
    try {
      await cancelOrgInvitation(client, { org, invitationId })
      onCanceled(row.key)
      onClose()
    } catch (err) {
      onError(
        row.key,
        t("students.cancelInviteFailed", {
          label,
          error: getErrorMessage(err),
        }),
      )
    } finally {
      setCancelling(false)
      setConfirmingCancel(false)
    }
  }

  const handleChangeRole = async () => {
    if (changingRole || !roleChanged) return
    const { key, username } = row
    if (!username) {
      onError(key, t("students.changeRoleNoUsername", { label }))
      return
    }
    setChangingRole(true)
    try {
      await applyClassroomRoleChange(client, {
        org,
        classroom,
        username,
        github_id: row.github_id,
        fromRoles: row.roles,
        toRole: selectedRole,
      })
      setPendingRole(null)
      setRoleOwnerConfirmed(false)
      onChanged(key)
      onClose()
    } catch (err) {
      onError(
        key,
        t("students.changeRoleFailed", { label, error: getErrorMessage(err) }),
      )
    } finally {
      setChangingRole(false)
    }
  }

  const handleUnenroll = async () => {
    if (working) return
    setWorking(true)
    try {
      const result = await unenrollMutation.mutateAsync(student)
      onUnenrolled(row.key, result.teamWarning)
      onClose()
    } catch (err) {
      onError(
        row.key,
        err instanceof Error ? err.message : t("students.somethingWentWrong"),
      )
    } finally {
      setWorking(false)
      setConfirmingUnenroll(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      closeDisabled={busy}
      hideCloseButton
      size="lg"
      boxClassName="p-0"
      aria-labelledby={titleId}
    >
      <div className="flex items-start justify-between gap-4 border-b border-base-300 px-6 py-4">
        <h2 id={titleId} className="text-lg font-bold">
          {t("students.detailTitle")}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          onClick={handleClose}
          disabled={busy}
          aria-label={t("common.close")}
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-5 px-6 py-5">
        {/* Identity with the enrollment actions as icons on the right — the
              GitHub username itself links to the profile. */}
        <div className="flex items-start justify-between gap-4">
          <Avatar
            name={displayName}
            github={row.username || row.email}
            initials={displayInitials}
            subtitle={
              row.username ? (
                <a
                  href={`https://github.com/${row.username}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <GitHub aria-hidden="true" className="size-3.5 opacity-70" />
                  <span className="font-mono">@{row.username}</span>
                  <ExternalLink aria-hidden="true" className="size-3" />
                </a>
              ) : row.email ? (
                <span className="text-sm text-base-content/70">
                  {row.email}
                </span>
              ) : undefined
            }
          />

          <div className="flex shrink-0 items-center gap-1">
            {needsInvite ? (
              <Button
                size="sm"
                loading={resolving}
                loadingLabel={t("common.working")}
                disabled={busy}
                onClick={() => void handleInvite()}
              >
                <UserPlus aria-hidden="true" className="size-4" />
                {t("students.inviteToOrg")}
              </Button>
            ) : null}

            {canResend && !confirmingResend ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingResend(true)}
              >
                <Send aria-hidden="true" className="size-4" />
                {t("students.resend")}
              </Button>
            ) : null}

            {canCancel && !confirmingCancel ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-error hover:bg-error/10"
                disabled={busy}
                onClick={() => setConfirmingCancel(true)}
              >
                <XCircle aria-hidden="true" className="size-4" />
                {t("students.cancelInvite")}
              </Button>
            ) : null}

            {canUnenroll && !confirmingUnenroll ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-error hover:bg-error/10"
                disabled={busy}
                onClick={() => setConfirmingUnenroll(true)}
              >
                <UserMinus aria-hidden="true" className="size-4" />
                {t("students.remove")}
              </Button>
            ) : null}
          </div>
        </div>

        {/* Non-owner: membership writes (invite/resend/cancel/unenroll/role) are
              owner-only, so we hide those actions and explain why rather than
              showing buttons that silently no-op. */}
        {!canManage && row.state !== "enrolled" ? (
          <p className="text-sm text-base-content/70">
            {t("students.manageOwnerOnly")}
          </p>
        ) : null}

        {/* Inline confirmations for the enrollment actions above. */}
        {(canResend && confirmingResend) ||
        (canCancel && confirmingCancel) ||
        confirmingUnenroll ? (
          <section className="flex flex-col gap-3">
            {canResend && confirmingResend ? (
              <div className="flex flex-col gap-3 rounded-box border border-primary/30 bg-primary/5 p-4 text-sm">
                <p className="text-base-content/80">
                  {t("students.confirmResendBody", {
                    label: row.username || row.email,
                    org,
                  })}
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={resending}
                    onClick={() => setConfirmingResend(false)}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={resending}
                    loadingLabel={t("common.working")}
                    disabled={resending}
                    onClick={() => void handleResend()}
                  >
                    {resending ? (
                      t("common.working")
                    ) : (
                      <>
                        <Send aria-hidden="true" className="size-4" />
                        {t("students.resend")}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            ) : null}

            {canCancel && confirmingCancel ? (
              <div className="flex flex-col gap-3 rounded-box border border-error/30 bg-error/5 p-4 text-sm">
                <p className="text-base-content/80">
                  {t("students.confirmCancelInviteBody", {
                    label: row.username || row.email,
                    org,
                  })}
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={cancelling}
                    onClick={() => setConfirmingCancel(false)}
                  >
                    {t("students.keepInvite")}
                  </Button>
                  <Button
                    variant="error"
                    size="sm"
                    loading={cancelling}
                    loadingLabel={t("common.working")}
                    disabled={cancelling}
                    onClick={() => void handleCancelInvite()}
                  >
                    {cancelling
                      ? t("common.working")
                      : t("students.cancelInvite")}
                  </Button>
                </div>
              </div>
            ) : null}

            {confirmingUnenroll ? (
              <div className="flex flex-col gap-3 rounded-box border border-error/30 bg-error/5 p-4 text-sm">
                <p className="text-base-content/80">
                  {t("students.unenrollBodyPrefix")}{" "}
                  <span className="font-semibold text-base-content">
                    {label}
                  </span>{" "}
                  {t("students.unenrollBodyFrom")}{" "}
                  <span className="font-semibold text-base-content">{org}</span>{" "}
                  {t("students.unenrollBodySuffix", { classroom })}
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={working}
                    onClick={() => setConfirmingUnenroll(false)}
                  >
                    {t("students.keepStudent")}
                  </Button>
                  <Button
                    variant="error"
                    size="sm"
                    loading={working}
                    loadingLabel={t("common.working")}
                    disabled={working}
                    onClick={() => void handleUnenroll()}
                  >
                    {working
                      ? t("common.working")
                      : t("students.unenrollStudent")}
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* Needs-attention resolution: an in-org member is enrolled as a student
              (TA/instructor roles are assigned in classroom Settings); a
              not-in-org row is invited via the header action. */}
        {needsRole ? (
          <section className="flex flex-col gap-3 rounded-box border border-warning/30 bg-warning/5 p-4">
            <p className="text-sm text-base-content/80">
              {t("students.needsAttentionInOrgHelp", { label })}
            </p>
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                loading={resolving}
                loadingLabel={t("common.working")}
                disabled={busy}
                onClick={() => void handleAssignRole()}
              >
                <UserPlus aria-hidden="true" className="size-4" />
                {t("students.assignRoleAction")}
              </Button>
            </div>
          </section>
        ) : null}

        {needsInvite ? (
          <p className="text-sm text-base-content/80">
            {t("students.needsAttentionNotInOrgHelp", { label })}
          </p>
        ) : null}

        {/* GitHub & enrollment — a single read-only summary: status + the
              classroom team. */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-base-content/50">
            {t("students.sectionGithub")}
          </h3>
          <div className="divide-y divide-base-300 rounded-box border border-base-300">
            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="text-sm text-base-content/70">
                {t("students.statusLabel")}
              </span>
              <Badge size="sm" tone={STATE_BADGE_TONE[row.state]}>
                {t(STATE_LABEL_KEY[row.state])}
              </Badge>
            </div>
            <div className="flex items-start justify-between gap-3 px-4 py-2.5">
              <span className="text-sm text-base-content/70">
                {t("students.classroomTeamLabel")}
              </span>
              {row.state === "enrolled" ? (
                <div className="flex flex-col items-end gap-1">
                  {sortRolesByRank(row.roles).map((r) => (
                    <a
                      key={r}
                      href={`https://github.com/orgs/${org}/teams/${teamSlugByRole[r]}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-sm text-primary hover:underline"
                    >
                      {teamSlugByRole[r]}
                      <ExternalLink aria-hidden="true" className="size-3.5" />
                    </a>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-base-content/50">
                  {t("students.teamNotYet")}
                </span>
              )}
            </div>

            {canChangeRole ? (
              <div className="flex flex-col gap-2 px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-base-content/70">
                    {t("students.roleLabel")}
                  </span>
                  <Select
                    selectSize="sm"
                    className="w-40"
                    aria-label={t("students.roleLabel")}
                    disabled={busy}
                    value={selectedRole}
                    onChange={(e) => {
                      const next = e.target.value as ClassroomRole
                      setPendingRole(next)
                      setRoleOwnerConfirmed(false)
                    }}
                  >
                    <option value="student">{t("students.roleStudent")}</option>
                    <option value="ta">{t("students.roleTa")}</option>
                    <option value="instructor">
                      {t("students.roleInstructor")}
                    </option>
                  </Select>
                </div>

                {roleChanged && roleGrantsOwner ? (
                  <label className="flex items-start gap-2 rounded-box border border-error/30 bg-error/5 p-3 text-sm">
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm mt-0.5"
                      checked={roleOwnerConfirmed}
                      onChange={(e) =>
                        setRoleOwnerConfirmed(e.currentTarget.checked)
                      }
                    />
                    <span>{t("students.changeRoleOwnerNotice")}</span>
                  </label>
                ) : null}

                {roleChanged ? (
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setPendingRole(null)
                        setRoleOwnerConfirmed(false)
                      }}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={changingRole}
                      loadingLabel={t("common.working")}
                      disabled={busy || !canApplyRole}
                      onClick={() => void handleChangeRole()}
                    >
                      {t("students.changeRoleApply")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {selfRoleBlocked ? (
              <p className="px-4 py-2.5 text-sm text-base-content/70">
                {t("students.changeRoleSelfBlocked")}
              </p>
            ) : null}
          </div>
        </section>

        {/* Profile — read-only by default with an inline Edit toggle, so the
              teacher isn't shown every action at once. */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-base-content/50">
              {t("students.sectionProfile")}
            </h3>
            {canEdit && !editingProfile ? (
              <Button
                variant="ghost"
                size="xs"
                className="gap-1"
                onClick={() => setEditingProfile(true)}
              >
                <Pencil aria-hidden="true" className="size-3.5" />
                {t("common.edit")}
              </Button>
            ) : null}
          </div>

          {!canEdit ? (
            <p className="text-sm text-base-content/70">
              {t("students.pendingNoEdit")}
            </p>
          ) : editingProfile ? (
            <EditStudentForm
              org={org}
              classroom={classroom}
              student={student}
              resetSignal={`${row.key}:${open}:${editingProfile}`}
              onCancel={() => setEditingProfile(false)}
              onSubmittingChange={setSubmitting}
              onSaved={(updated) => {
                onSaved(row.key, updated)
                setEditingProfile(false)
              }}
              showGitHubPanel={false}
            />
          ) : (
            <dl className="divide-y divide-base-300 rounded-box border border-base-300">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <dt className="text-sm text-base-content/70">
                  {t("students.nameColumn")}
                </dt>
                <dd className="text-sm">
                  {nameFromParts(row.first_name, row.last_name) || (
                    <span className="text-base-content/40">
                      {t("students.notSet")}
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <dt className="text-sm text-base-content/70">
                  {t("students.emailColumn")}
                </dt>
                <dd className="text-sm">
                  {row.email || (
                    <span className="text-base-content/40">
                      {t("students.notSet")}
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <dt className="text-sm text-base-content/70">
                  {t("students.sectionColumn")}
                </dt>
                <dd className="text-sm">
                  {row.section.trim() || (
                    <span className="text-base-content/40">
                      {t("students.notSet")}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          )}
        </section>
      </div>
    </Modal>
  )
}

export default RosterMemberModal
