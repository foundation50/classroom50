import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ExternalLink,
  Pencil,
  Send,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react"

import { useMutation } from "@tanstack/react-query"

import Avatar from "@/components/avatar"
import GitHub from "@/assets/github.svg?react"
import EditStudentForm from "@/pages/students/EditStudentForm"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  assignRosterMemberRole,
  inviteRosterStudents,
  unenrollStudent,
  type StudentCsvRow,
} from "@/api/mutations/students"
import { resendOrgInvitation, getErrorMessage } from "@/hooks/github/mutations"
import { nameFromParts, parseGitHubId } from "@/util/students"
import { rosterRowInitials } from "@/util/memberRow"
import {
  rowToStudent,
  sortRolesByRank,
  type RosterRole,
  type TeamRosterRow,
} from "@/util/teamRoster"
import {
  hasStudentEnrollment,
  STATE_BADGE_TONE,
  STATE_LABEL_KEY,
} from "@/util/rosterRoles"
import { Badge, Button, Modal } from "@/components/ui"

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
  row,
  onClose,
  onSaved,
  onUnenrolled,
  onResent,
  onChanged,
  onError,
}: {
  open: boolean
  org: string
  classroom: string
  // Resolved team slug per role, so each role a member actually holds links to
  // its real team (student -> classroom team, instructor/ta -> the staff team)
  // instead of assuming everyone is on the student team.
  teamSlugByRole: Record<RosterRole, string>
  // Nullable so the <dialog> can stay mounted across open/close.
  row: TeamRosterRow | null
  onClose: () => void
  onSaved: (rowKey: string, updated: StudentCsvRow) => void
  onUnenrolled: (rowKey: string, teamWarning?: string) => void
  onResent: (rowKey: string) => void
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
  const [editingProfile, setEditingProfile] = useState(false)
  const [working, setWorking] = useState(false)
  const [resending, setResending] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [resolving, setResolving] = useState(false)

  const unenrollMutation = useMutation({
    mutationFn: (student: ReturnType<typeof rowToStudent>) =>
      unenrollStudent(client, { org, classroom, student }),
  })

  // `resending` covers an in-flight invite/resend; folding it into `busy` keeps
  // the modal non-closeable (button, backdrop, Escape) while a write is pending,
  // matching the unenroll (`working`) guard. Without it, closing or switching
  // rows mid-invite would let the captured-row promise apply onResent/onError/
  // onClose to a stale student.
  const busy = working || submitting || resending || resolving

  const handleClose = () => {
    if (busy) return
    setConfirmingUnenroll(false)
    setConfirmingResend(false)
    setEditingProfile(false)
    onClose()
  }

  if (!row) {
    // No selected row: render nothing (the modal is closed in this state).
    return <Modal open={open} onClose={handleClose} aria-labelledby={titleId} />
  }

  const student = rowToStudent(row)
  // A staff-only row (instructor/TA with no student enrollment) has no
  // roster.csv row and isn't on the student team — the student-roster actions
  // (edit CSV metadata, unenroll) don't apply. Staff are managed in Settings. A
  // person who is BOTH staff and a student keeps the student actions (they do
  // have a student enrollment), so gate on the student enrollment, not
  // "student is the sole role" (hasStudentEnrollment — shared with the bulk gate).
  const staffOnly = !hasStudentEnrollment(row)
  const canEdit = !staffOnly && row.state !== "pending"
  const displayName =
    nameFromParts(row.first_name, row.last_name) || row.username || row.email
  const displayInitials = rosterRowInitials(row)
  const label = row.username || row.email
  const canResend = row.state === "pending" && Boolean(row.github_id)
  const needsRole = row.state === "needs_attention_in_org"
  const needsInvite = row.state === "needs_attention_not_in_org"
  // Unenroll drops a roster.csv row + student-team membership — a student-only
  // action. Hidden for a staff-only row (nothing to unenroll from the roster).
  const canUnenroll = !staffOnly

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
      await resendOrgInvitation(client, {
        org,
        username: row.username,
        inviteeId,
        invitationId: row.invitation_id,
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

        {/* Inline confirmations for the enrollment actions above. */}
        {(canResend && confirmingResend) || confirmingUnenroll ? (
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

          {staffOnly ? (
            <p className="text-sm text-base-content/70">
              {t("students.staffManagedInSettings")}
            </p>
          ) : !canEdit ? (
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
