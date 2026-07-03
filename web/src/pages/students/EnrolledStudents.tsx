import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Link as LinkIcon,
  Pencil,
  RefreshCw,
  Send,
  Trash,
  UserCheck,
} from "lucide-react"

import {
  isSameGitHubUser,
  nameFromParts,
  initialsFromParts,
} from "@/util/students"
import { formatInvitedAt } from "@/util/formatDate"
import Avatar from "@/components/avatar"
import type { Student } from "@/types/classroom"
import { ConfirmModal } from "@/components/modals"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  reconcileOnboarding,
  unenrollStudent,
  markStudentEnrolledWithConflictRetry,
  matchStudentToAccountWithConflictRetry,
} from "@/api/mutations/students"
import type { UnenrollStudentInput } from "@/api/mutations/students"
import { resendOrgInvitation, getErrorMessage } from "@/hooks/github/mutations"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { useToast } from "@/context/notifications/NotificationProvider"
import useGetOrgMembers from "@/hooks/useGetOrgMembers"
import { GitHubAPIError } from "@/hooks/github/errors"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { invalidateInviteQueries as invalidateInviteQueriesForOrg } from "@/hooks/github/queries"
import { useUpdateRosterCache } from "@/hooks/useGetStudents"
import useRosterStatus from "@/hooks/useRosterStatus"
import { useGitHubViewer } from "@/hooks/github/hooks"
import { type InviteStatus, memberIdSet } from "@/util/inviteStatus"
import type { OnboardingSelfReport } from "@/util/inviteStatus"
import {
  applyReconciledToRoster,
  removeFromRoster,
  studentKey,
  toStudent,
} from "@/util/roster"
import { unmatchedTeamMembers, type MatchCandidate } from "@/util/orgMembers"
import EditStudent from "@/pages/students/EditStudent"
import type { StudentCsvRow } from "@/api/mutations/students"
import { Link2 } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { collapseVariants, enterExit } from "@/lib/motion"
import { EnterDiv } from "@/lib/motionComponents"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

// Group students by roster `section`, sorted by name with the unlabeled
// ("No section") bucket last. Section labels are trimmed; blank/absent folds
// into the unlabeled bucket.
const NO_SECTION = "No section"
export function groupStudentsBySection(
  students: Student[],
): Array<{ section: string; students: Student[] }> {
  const bySection = new Map<string, Student[]>()
  for (const student of students) {
    const label = student.section?.trim() || NO_SECTION
    const bucket = bySection.get(label)
    if (bucket) bucket.push(student)
    else bySection.set(label, [student])
  }
  return Array.from(bySection.entries())
    .sort(([a], [b]) => {
      // Unlabeled bucket always last; otherwise locale-compare section names.
      if (a === NO_SECTION) return 1
      if (b === NO_SECTION) return -1
      return a.localeCompare(b, undefined, { numeric: true })
    })
    .map(([section, group]) => ({ section, students: group }))
}

const EditStudentButton = ({
  org,
  classroom,
  student,
  selfReport,
  onSaved,
}: {
  org: string
  classroom: string
  student: Student
  selfReport?: OnboardingSelfReport
  onSaved: (updated: StudentCsvRow) => void
}) => {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  const label = student.username || student.email

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-ghost btn-square"
        aria-label={t("students.editStudentAria", { label })}
        title={t("students.editStudentTitle")}
      >
        <Pencil aria-hidden="true" className="size-4" />
      </button>

      <EditStudent
        org={org}
        classroom={classroom}
        student={student}
        selfReport={selfReport}
        open={open}
        onClose={() => setOpen(false)}
        onSaved={(updated) => {
          onSaved(updated)
          setOpen(false)
        }}
      />
    </>
  )
}

const UnenrollStudentButton = ({
  org,
  classroom,
  student,
  status,
  isSelf = false,
  onRemoveStudent,
}: {
  org: string
  classroom: string
  student: Student
  status?: InviteStatus
  isSelf?: boolean
  onRemoveStudent: (username: string, teamWarning?: string) => void
}) => {
  const client = useGitHubClient()
  const { t } = useTranslation()
  const unenrollStudentMutation = useMutation({
    mutationFn: (input: UnenrollStudentInput) => unenrollStudent(client, input),
  })
  const [open, setOpen] = useState(false)

  // Org removal now lives on the org Members page, where the student's full
  // cross-classroom footprint is visible.
  const isMember = status === "member"
  // Email-invited rows have no username yet; show the email so the row is
  // identifiable before reconciliation.
  const label = student.username || student.email
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  const closeDialog = () => {
    if (submitting) return
    setOpen(false)
    setError(null)
  }

  const handleConfirm = async () => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await unenrollStudentMutation.mutateAsync({
        org,
        classroom,
        student,
      })
      // Key the warning by a stable identity (username, else email): this button
      // unmounts on refetch, and keying stops a concurrent clean unenroll from
      // clobbering it.
      onRemoveStudent(student.username || student.email, result.teamWarning)
      setOpen(false)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("students.somethingWentWrong"),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={unenrollStudentMutation.isPending}
        className="btn btn-ghost btn-square text-error"
        aria-label={t("students.unenrollStudentAria", { label })}
      >
        <Trash aria-hidden="true" />
      </button>

      <dialog
        ref={dialogRef}
        className="modal"
        aria-labelledby={titleId}
        onClose={closeDialog}
        onCancel={(event) => {
          if (submitting) {
            event.preventDefault()
            return
          }
          closeDialog()
        }}
      >
        <div className="modal-box max-w-lg">
          <h3 id={titleId} className="text-lg font-bold">
            {t("students.unenrollTitle")}
          </h3>

          <div className="mt-2 text-sm leading-6 text-base-content/70">
            {t("students.unenrollBodyPrefix")}{" "}
            <span className="font-semibold text-base-content">{label}</span>{" "}
            {t("students.unenrollBodyFrom")}{" "}
            <span className="font-semibold text-base-content">{org}</span>{" "}
            {t("students.unenrollBodySuffix", { classroom })}
            {status === "pending" ? (
              <span className="mt-2 block">
                {t("students.unenrollPendingNote")}
              </span>
            ) : null}
            {status === "onboarding" ? (
              <span className="mt-2 block">
                {t("students.unenrollOnboardingNote")}
              </span>
            ) : null}
          </div>

          {isMember && isSelf ? (
            <div className="mt-4 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
              {t("students.unenrollSelfPrefix")}{" "}
              <span className="font-semibold">{org}</span>{" "}
              {t("students.unenrollSelfSuffix")}
            </div>
          ) : null}

          {isMember && !isSelf ? (
            <p className="mt-3 text-sm text-base-content/70">
              {t("students.unenrollMemberPrefix")}{" "}
              <span className="font-semibold">{org}</span>{" "}
              {t("students.unenrollMemberSuffix")}
            </p>
          ) : null}

          {error ? (
            <div className="alert alert-error alert-soft mt-4 text-sm">
              {error}
            </div>
          ) : null}

          <div className="modal-action">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={submitting}
              onClick={closeDialog}
            >
              {t("students.keepStudent")}
            </button>
            <button
              type="button"
              className="btn btn-error"
              disabled={submitting}
              onClick={() => void handleConfirm()}
            >
              {submitting ? (
                <>
                  <span
                    className="loading loading-spinner loading-sm"
                    aria-hidden="true"
                  />
                  {t("common.working")}
                </>
              ) : (
                t("students.unenrollStudent")
              )}
            </button>
          </div>
        </div>

        <form method="dialog" className="modal-backdrop">
          <button type="button" disabled={submitting} onClick={closeDialog}>
            {t("common.close")}
          </button>
        </form>
      </dialog>
    </>
  )
}

// Native GitHub org-invite link, behind an expandable toggle (the in-app
// onboarding link is the primary path). Same org-wide URL for everyone.
const InviteLink = ({
  org,
  expanded,
  onToggle,
}: {
  org: string
  expanded: boolean
  onToggle: () => void
}) => {
  const inviteUrl = `https://github.com/orgs/${org}/invitation`
  const { copied, copy } = useCopyToClipboard(inviteUrl)
  const { t } = useTranslation()

  return (
    <div className="border-b border-base-300 bg-base-200/40 px-6 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-1 text-xs font-medium text-base-content/70 hover:text-base-content"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" className="size-3.5" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-3.5" />
        )}
        {t("students.nativeInviteToggle")}
      </button>
      {expanded ? (
        <div className="mt-2 flex flex-col gap-1">
          <span className="text-xs text-base-content/70">
            {t("students.nativeInviteHint")}
          </span>
          <div className="join w-full">
            <input
              type="text"
              readOnly
              value={inviteUrl}
              aria-label={t("students.studentInviteLinkAria")}
              onFocus={(event) => event.currentTarget.select()}
              className="input input-sm input-bordered join-item w-full font-mono text-xs"
            />
            <button
              type="button"
              className="btn btn-sm join-item"
              onClick={() => void copy()}
              aria-label={t("students.copyInviteLinkAria")}
            >
              {copied ? (
                <>
                  <Check aria-hidden="true" className="size-4 text-success" />
                  {t("students.copied")}
                </>
              ) : (
                <>
                  <Copy aria-hidden="true" className="size-4" />
                  {t("students.copy")}
                </>
              )}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// Per-student secure onboarding link (icon-only): carries the email prefill and
// unguessable invite token so reconcile binds the self-report to this row. Shown
// only for a pending-invite student.
const SecureLinkButton = ({
  org,
  classroom,
  email,
  token,
}: {
  org: string
  classroom: string
  email: string
  token: string
}) => {
  const secureUrl = `${window.location.origin}/${org}/${classroom}/onboard?email=${encodeURIComponent(
    email,
  )}&t=${token}`
  const { copied, copy } = useCopyToClipboard(secureUrl)
  const { t } = useTranslation()

  return (
    <button
      type="button"
      className="btn btn-xs btn-square btn-ghost"
      onClick={() => void copy()}
      aria-label={t("students.copySecureLinkAria", { email })}
      title={t("students.copySecureLinkTitle")}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-4 text-success" />
      ) : (
        <LinkIcon aria-hidden="true" className="size-4" />
      )}
    </button>
  )
}

// Classroom-wide onboarding link. Students open it after accepting the org
// invite and self-report their GitHub identity. Same URL for everyone; the
// student supplies the email, so no per-student token is needed.
const OnboardingLink = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const onboardUrl = `${window.location.origin}/${org}/${classroom}/onboard`
  const { copied, copy } = useCopyToClipboard(onboardUrl)
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-1 px-6 py-3 border-b border-base-300 bg-base-200/40">
      <span className="text-xs font-medium text-base-content/70">
        {t("students.onboardingLinkHint")}
      </span>
      <div className="join w-full">
        <input
          type="text"
          readOnly
          value={onboardUrl}
          aria-label={t("students.onboardingLinkAria")}
          onFocus={(event) => event.currentTarget.select()}
          className="input input-sm input-bordered join-item w-full font-mono text-xs"
        />
        <button
          type="button"
          className="btn btn-sm join-item"
          onClick={() => void copy()}
          aria-label={t("students.copyOnboardingLinkAria")}
        >
          {copied ? (
            <>
              <Check aria-hidden="true" className="size-4 text-success" />
              {t("students.copied")}
            </>
          ) : (
            <>
              <Copy aria-hidden="true" className="size-4" />
              {t("students.copy")}
            </>
          )}
        </button>
      </div>
    </div>
  )
}

// Manual-match affordance for an email-invited row whose student joined the org
// directly (accepted the GitHub invite, so no onboarding repo) and whose GitHub
// identity GitHub no longer exposes (the email->login link is dropped once an
// invite is accepted). The teacher picks which unmatched team member owns the
// email; matchStudentToAccount re-verifies the pick is an active member before
// binding. Candidates are org members not already on this roster.
const MatchAccountButton = ({
  org,
  classroom,
  student,
  candidates,
  onMatched,
}: {
  org: string
  classroom: string
  student: Student
  candidates: MatchCandidate[]
  onMatched: (student: Student, teamWarning?: string) => void
}) => {
  const client = useGitHubClient()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  const close = () => {
    if (submitting) return
    setOpen(false)
    setError(null)
    setSelected(null)
    setFilter("")
  }

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter(
      (c) =>
        c.login.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
    )
  }, [candidates, filter])

  const selectedCandidate = useMemo(
    () => candidates.find((c) => c.github_id === selected) ?? null,
    [candidates, selected],
  )

  const handleConfirm = async () => {
    if (submitting || !selected) return
    const pick = candidates.find((c) => c.github_id === selected)
    if (!pick) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await matchStudentToAccountWithConflictRetry(client, {
        org,
        classroom,
        email: student.email,
        username: pick.login,
        github_id: pick.github_id,
      })
      onMatched(toStudent(result.student), result.teamWarning)
      setOpen(false)
      setSelected(null)
      setFilter("")
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("students.somethingWentWrong"),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-xs btn-primary"
        aria-label={t("students.matchAccountAria", { email: student.email })}
        title={t("students.matchAccountTitle")}
        onClick={() => setOpen(true)}
      >
        <Link2 aria-hidden="true" className="size-3.5" />
        {t("students.matchAccount")}
      </button>

      <dialog
        ref={dialogRef}
        className="modal"
        aria-labelledby={titleId}
        onClose={close}
        onCancel={(event) => {
          if (submitting) {
            event.preventDefault()
            return
          }
          close()
        }}
      >
        <div className="modal-box max-w-lg">
          <h3 id={titleId} className="text-lg font-bold">
            {t("students.matchTitle")}
          </h3>
          <p className="mt-2 text-sm leading-6 text-base-content/70">
            <span className="font-semibold text-base-content">
              {student.email}
            </span>{" "}
            {t("students.matchBodyPrefix")}{" "}
            <span className="font-semibold text-base-content">{org}</span>{" "}
            {t("students.matchBodySuffix")}
          </p>

          {candidates.length === 0 ? (
            <div className="mt-4 rounded-box border border-base-300 bg-base-200/50 p-4 text-sm text-base-content/70">
              {t("students.matchNoCandidates")}
            </div>
          ) : (
            <>
              <input
                type="text"
                value={filter}
                placeholder={t("students.matchFilterPlaceholder")}
                aria-label={t("students.matchFilterAria")}
                className="input input-sm input-bordered mt-4 w-full"
                onChange={(e) => setFilter(e.target.value)}
                disabled={submitting}
              />
              <ul className="menu mt-2 max-h-64 w-full flex-nowrap overflow-y-auto rounded-box border border-base-300 p-1">
                {filtered.length === 0 ? (
                  <li className="px-3 py-2 text-sm text-base-content/70">
                    {t("students.matchNoResults", { filter })}
                  </li>
                ) : (
                  filtered.map((c) => {
                    const isSelected = selected === c.github_id
                    return (
                      <li key={c.github_id}>
                        <button
                          type="button"
                          className={`flex items-center justify-between gap-2${
                            isSelected
                              ? " active ring-2 ring-primary ring-inset"
                              : ""
                          }`}
                          aria-pressed={isSelected}
                          onClick={() => setSelected(c.github_id)}
                          disabled={submitting}
                        >
                          <Avatar
                            name={c.name || c.login}
                            github={c.login}
                            subtitle={`@${c.login}`}
                            initials={
                              (c.name || c.login)[0]?.toUpperCase() ?? "?"
                            }
                          />
                          {isSelected ? (
                            <Check
                              aria-hidden="true"
                              className="size-4 shrink-0 text-primary"
                            />
                          ) : null}
                        </button>
                      </li>
                    )
                  })
                )}
              </ul>

              {selectedCandidate ? (
                <div className="mt-3 flex items-center gap-2 rounded-box border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                  <Check
                    aria-hidden="true"
                    className="size-4 shrink-0 text-primary"
                  />
                  <span className="text-base-content/80">
                    {t("students.matchSelectedPrefix")}{" "}
                    <span className="font-semibold text-base-content">
                      {selectedCandidate.name || selectedCandidate.login}
                    </span>{" "}
                    <span className="text-base-content/70">
                      (@{selectedCandidate.login})
                    </span>
                  </span>
                </div>
              ) : (
                <p className="mt-3 text-sm text-base-content/70">
                  {t("students.matchSelectHint")}
                </p>
              )}
            </>
          )}

          {error ? (
            <div className="alert alert-error alert-soft mt-4 text-sm">
              {error}
            </div>
          ) : null}

          <div className="modal-action">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={close}
              disabled={submitting}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitting || !selected}
              onClick={() => void handleConfirm()}
            >
              {submitting ? (
                <span
                  className="loading loading-spinner loading-sm"
                  aria-hidden="true"
                />
              ) : selectedCandidate ? (
                t("students.confirmMatchWith", {
                  login: selectedCandidate.login,
                })
              ) : (
                t("students.confirmMatch")
              )}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="button" onClick={close} aria-label={t("common.close")}>
            {t("common.close")}
          </button>
        </form>
      </dialog>
    </>
  )
}

const EnrolledStudents = ({
  students = [],
  org,
  classroom,
}: {
  students: Student[]
  org: string
  classroom: string
}) => {
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const updateRosterCache = useUpdateRosterCache(org, classroom)
  // Keyed by username so a clean unenroll can't clobber another student's warning.
  const [teamWarnings, setTeamWarnings] = useState<Record<string, string>>({})
  const [confirmResendAllOpen, setConfirmResendAllOpen] = useState(false)
  // Native GitHub org-invite link is secondary; keep it behind a toggle.
  const [showGithubInvite, setShowGithubInvite] = useState(false)
  const [resendingUsernames, setResendingUsernames] = useState<Set<string>>(
    new Set(),
  )
  // Optional "group by section" view. Off by default; only meaningful when
  // the roster carries sections.
  const [groupBySection, setGroupBySection] = useState(false)

  const { data: viewer } = useGitHubViewer()
  const { notify } = useToast()
  const { members } = useGetOrgMembers(org)
  // Live member github_ids (cache hit — useRosterStatus already fetched them),
  // for gating the "Mark enrolled" affordance.
  const memberIds = useMemo(() => memberIdSet(members ?? []), [members])
  // Org members not already bound to any roster row in this classroom — the
  // candidate set for manually matching an email-invited student who joined the
  // org directly (no onboarding repo).
  const matchCandidates = useMemo(
    () => unmatchedTeamMembers(members ?? [], students),
    [members, students],
  )
  const {
    statusByKey,
    getStatus,
    statusAvailable,
    reportsErrored,
    rosterReady,
    partition: { readyToConfirm, awaitingEnrollment, enrolled },
  } = useRosterStatus(org, classroom, students)

  // Does the roster carry any section labels? (gates the toggle)
  const hasSections = useMemo(
    () => students.some((s) => s.section?.trim()),
    [students],
  )

  // Enrolled students grouped by section. Computed regardless of the toggle so
  // the data is ready when grouping is turned on.
  const enrolledBySection = useMemo(
    () => groupStudentsBySection(enrolled),
    [enrolled],
  )

  // Non-members still needing an invite re-sent: pending, expired, or never
  // invited. Excludes onboarded/awaiting rows — they've accepted.
  const nonMemberStudents = useMemo(
    () =>
      students.filter((student) => {
        const status = statusByKey.get(studentKey(student))?.status
        return (
          status != null &&
          status !== "member" &&
          status !== "onboarding" &&
          status !== "ready"
        )
      }),
    [students, statusByKey],
  )

  const setWarning = (username: string, message: string) =>
    setTeamWarnings((prev) => ({ ...prev, [username]: message }))

  const dismissWarning = (username: string) =>
    setTeamWarnings((prev) => {
      const next = { ...prev }
      delete next[username]
      return next
    })

  const invalidateInviteQueries = () =>
    invalidateInviteQueriesForOrg(queryClient, org)

  // Resend (or first-time invite for "none"). "expired" carries an invitation id
  // we cancel first; "none" is a plain create. Outcome distinguishes what
  // happened: "invited" = sent; "pending"/"active" = no-op; "skipped" = missing id.
  type ResendOutcome = "invited" | "pending" | "active" | "skipped"

  const resendForStudent = async (student: Student): Promise<ResendOutcome> => {
    const inviteeId = Number(student.github_id)
    if (!Number.isFinite(inviteeId) || inviteeId <= 0) {
      setWarning(
        student.username,
        t("students.resendMissingId", { username: student.username }),
      )
      return "skipped"
    }

    const status = getStatus(student)
    const result = await resendOrgInvitation(client, {
      org,
      username: student.username,
      inviteeId,
      invitationId: status?.invitationId,
    })
    return result.state
  }

  const resendMutation = useMutation({
    mutationFn: (student: Student) => resendForStudent(student),
  })

  const [reconcileSummary, setReconcileSummary] = useState("")
  const runReconcile = useSafeSubmit()

  const reconcileMutation = useMutation({
    mutationFn: () => reconcileOnboarding(client, { org, classroom }),
    onSuccess: (result) => {
      const parts = [
        t("students.reconcileEnrolled", { count: result.reconciled.length }),
      ]
      if (result.deleted.length > 0) {
        parts.push(
          t("students.reconcileDeleted", { count: result.deleted.length }),
        )
      }
      if (result.archived.length > 0) {
        parts.push(
          t("students.reconcileArchived", { count: result.archived.length }),
        )
      }
      if (result.pending.length > 0) {
        parts.push(
          t("students.reconcilePending", { count: result.pending.length }),
        )
      }
      if (result.needsAttention.length > 0) {
        parts.push(
          t("students.reconcileNeedsAttention", {
            count: result.needsAttention.length,
          }),
        )
      }
      if (result.needsMatch.length > 0) {
        parts.push(
          t("students.reconcileNeedsMatch", {
            count: result.needsMatch.length,
          }),
        )
      }
      if (result.unmatched.length > 0) {
        parts.push(
          t("students.reconcileUnmatched", { count: result.unmatched.length }),
        )
      }
      const summary = parts.join(", ")
      setReconcileSummary(
        result.cleanupWarning
          ? `${summary}. ${result.cleanupWarning}`
          : summary,
      )
      // Optimistically flip just-confirmed rows to "enrolled" so they move to
      // Enrolled immediately. Don't invalidate the roster CSV query (see
      // useUpdateRosterCache); a natural refetch reconciles later.
      updateRosterCache((current) =>
        applyReconciledToRoster(current, result.reconciled),
      )
      // Reconcile deletes/archives onboarding repos, so the ready-to-confirm
      // self-report set is now stale.
      queryClient.invalidateQueries({
        queryKey: ["github", "onboarding-reports", org, classroom],
      })
      invalidateInviteQueries()
    },
    onError: (err) => {
      setReconcileSummary(
        t("students.reconcileFailed", { error: getErrorMessage(err) }),
      )
    },
  })

  // Per-row confirm for an already-member with no onboarding repo (reconcile
  // can't confirm those); the mutation re-verifies membership server-side.
  const runMarkEnrolled = useSafeSubmit()
  const [markingUsernames, setMarkingUsernames] = useState<Set<string>>(
    new Set(),
  )

  const markEnrolledMutation = useMutation({
    mutationFn: (student: Student) =>
      markStudentEnrolledWithConflictRetry(client, {
        org,
        classroom,
        username: student.username,
        github_id: student.github_id || undefined,
      }),
  })

  const handleMarkEnrolled = async (student: Student) => {
    setMarkingUsernames((prev) => new Set(prev).add(student.username))
    dismissWarning(student.username)
    try {
      const result = await markEnrolledMutation.mutateAsync(student)
      // Optimistic flip to enrolled; a refetch reconciles the remaining fields.
      updateRosterCache((current) =>
        current.map((s) =>
          studentKey(s) === studentKey(student)
            ? { ...s, enrollment_status: "enrolled" as const }
            : s,
        ),
      )
      invalidateInviteQueries()
      notify({
        tone: result.teamWarning ? "warning" : "success",
        durationMs: 6000,
        message: result.teamWarning
          ? result.teamWarning
          : t("students.markedEnrolled", { username: student.username }),
      })
    } catch (err) {
      notify({
        tone: "error",
        message: t("students.markEnrolledFailed", {
          username: student.username,
          error: getErrorMessage(err),
        }),
      })
    } finally {
      setMarkingUsernames((prev) => {
        const next = new Set(prev)
        next.delete(student.username)
        return next
      })
    }
  }

  const handleResend = async (student: Student) => {
    setResendingUsernames((prev) => new Set(prev).add(student.username))
    dismissWarning(student.username)
    try {
      await resendMutation.mutateAsync(student)
      invalidateInviteQueries()
    } catch (err) {
      setWarning(
        student.username,
        t("students.resendFailed", {
          username: student.username,
          error: getErrorMessage(err),
        }),
      )
    } finally {
      setResendingUsernames((prev) => {
        const next = new Set(prev)
        next.delete(student.username)
        return next
      })
    }
  }

  // Sequential to respect GitHub's 50/24h invite cap and secondary rate limits.
  // Stops early on a rate-limit error.
  const handleResendAll = async () => {
    let resent = 0
    let alreadyValid = 0
    const failures: string[] = []
    let rateLimited = false
    let stoppedAt = 0

    for (const student of nonMemberStudents) {
      stoppedAt++
      try {
        const outcome = await resendForStudent(student)
        if (outcome === "invited") resent++
        // "pending"/"active" = already valid / a member; not a failure.
        else if (outcome === "pending" || outcome === "active") alreadyValid++
        else failures.push(student.username)
      } catch (err) {
        failures.push(student.username)
        console.error(`resend failed for ${student.username}:`, err)
        if (err instanceof GitHubAPIError && err.isRateLimited) {
          rateLimited = true
          break
        }
      }
    }

    invalidateInviteQueries()

    const remaining = nonMemberStudents.length - stoppedAt
    const alreadyNote =
      alreadyValid > 0
        ? " " + t("students.resendAllAlreadyNote", { count: alreadyValid })
        : ""
    const summaryKey = "__resend_all__"
    if (rateLimited) {
      const failedList = failures.length ? ` (${failures.join(", ")})` : ""
      setWarning(
        summaryKey,
        t("students.resendAllRateLimited", {
          resent,
          failed: failures.length,
          failedList,
          remaining:
            remaining > 0
              ? t("students.resendAllNotAttempted", { count: remaining })
              : "",
        }),
      )
    } else if (failures.length === 0) {
      setWarning(
        summaryKey,
        t("students.resendAllSuccess", { count: resent }) + alreadyNote,
      )
    } else {
      setWarning(
        summaryKey,
        t("students.resendAllPartial", {
          resent,
          total: nonMemberStudents.length,
          failed: failures.length,
          failedList: failures.join(", "),
        }) + alreadyNote,
      )
    }
  }

  const renderStudentRow = (student: Student) => {
    const rowKey = studentKey(student)
    const statusEntry = statusByKey.get(rowKey)
    const status = statusEntry?.status
    // Per-row invite (re)send: offered for an outstanding invite (pending/expired)
    // or a never-invited row (none). An email-only row (no github_id) can't be
    // org-resent — skip it (also avoids an empty-username key collision below).
    const showResend =
      (status === "pending" || status === "expired" || status === "none") &&
      Boolean(student.github_id)
    const isResending = resendingUsernames.has(student.username)
    // Show "Mark enrolled" only for a verified live member stuck awaiting (not
    // already enrolled, not onboarding-confirmable); needs a github_id to verify.
    const isVerifiedMember =
      Boolean(student.github_id) && memberIds.has(student.github_id)
    const showMarkEnrolled =
      statusAvailable &&
      isVerifiedMember &&
      status !== "member" &&
      status !== "removed" &&
      status !== "ready"
    const isMarking = markingUsernames.has(student.username)
    // Show "Match account" for an email-invited row with no GitHub identity yet
    // that isn't showing a self-report or outstanding invite — the student
    // likely joined the org directly (no onboarding repo). The teacher binds it
    // to an org member by hand (email->login isn't recoverable post-accept).
    const isEmailOnly = !student.github_id.trim() && !student.username.trim()
    const showMatchAccount =
      statusAvailable &&
      isEmailOnly &&
      Boolean(student.email.trim()) &&
      status === "onboarding"
    const invitedAtLabel =
      status === "pending" || status === "expired"
        ? formatInvitedAt(statusEntry?.invitedAt)
        : null
    const isSelf = isSameGitHubUser(viewer, student)
    // CSV is authoritative for the displayed name; when a row has no name on the
    // CSV (common for an onboarded-but-unenrolled, email-invited student), fall
    // back to the student's onboarding self-report so the row reads as a person
    // rather than a bare email.
    const selfReport = statusEntry?.selfReport
    const displayName =
      nameFromParts(student.first_name, student.last_name) ||
      nameFromParts(selfReport?.first_name, selfReport?.last_name) ||
      student.email
    const displayHandle =
      student.username || selfReport?.github_username || student.email
    const displayInitials =
      initialsFromParts(student.first_name, student.last_name) ||
      initialsFromParts(selfReport?.first_name, selfReport?.last_name) ||
      student.email[0]?.toUpperCase() ||
      "?"

    return (
      <motion.li
        key={rowKey}
        layout
        variants={enterExit}
        initial="initial"
        animate="animate"
        exit="exit"
        className="flex items-center justify-between gap-4 px-6 py-4"
      >
        <div className="min-w-0 flex-1">
          <Avatar
            name={displayName}
            github={displayHandle}
            subtitle={displayHandle ? `@${displayHandle}` : undefined}
            initials={displayInitials}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {student.section?.trim() ? (
            <span className="badge badge-sm badge-ghost shrink-0">
              {student.section.trim()}
            </span>
          ) : null}

          {statusAvailable && invitedAtLabel ? (
            <span className="whitespace-nowrap text-xs text-base-content/70">
              {t("students.invitedAt", { date: invitedAtLabel })}
            </span>
          ) : null}

          {statusAvailable && showResend ? (
            <button
              type="button"
              className="btn btn-xs"
              disabled={isResending}
              aria-label={
                status === "none"
                  ? t("students.sendInviteAria", { username: student.username })
                  : t("students.resendInviteAria", {
                      username: student.username,
                    })
              }
              onClick={() => void handleResend(student)}
            >
              {isResending ? (
                <span
                  className="loading loading-spinner loading-xs"
                  aria-hidden="true"
                />
              ) : status === "none" ? (
                t("students.sendInvite")
              ) : (
                t("students.resend")
              )}
            </button>
          ) : null}

          {statusAvailable && status === "pending" && student.invite_token ? (
            <SecureLinkButton
              org={org}
              classroom={classroom}
              email={student.email}
              token={student.invite_token}
            />
          ) : null}

          {showMarkEnrolled ? (
            <button
              type="button"
              className="btn btn-xs btn-primary"
              disabled={isMarking}
              aria-label={t("students.markEnrolledAria", {
                username: student.username,
              })}
              title={t("students.markEnrolledTitle")}
              onClick={() =>
                void runMarkEnrolled(() => handleMarkEnrolled(student))
              }
            >
              {isMarking ? (
                <span
                  className="loading loading-spinner loading-xs"
                  aria-hidden="true"
                />
              ) : (
                <>
                  <UserCheck aria-hidden="true" className="size-3.5" />
                  {t("students.markEnrolled")}
                </>
              )}
            </button>
          ) : null}

          {showMatchAccount ? (
            <MatchAccountButton
              org={org}
              classroom={classroom}
              student={student}
              candidates={matchCandidates}
              onMatched={(matched, warning) => {
                if (warning) {
                  setWarning(matched.username || student.email, warning)
                }
                // Optimistically reflect the bound identity + enrolled status so
                // the row moves out of "awaiting" immediately; a refetch
                // reconciles the rest.
                updateRosterCache((current) =>
                  current.map((s) =>
                    studentKey(s) === rowKey
                      ? {
                          ...s,
                          username: matched.username,
                          github_id: matched.github_id,
                          enrollment_status: "enrolled" as const,
                        }
                      : s,
                  ),
                )
                invalidateInviteQueries()
                notify({
                  tone: warning ? "warning" : "success",
                  durationMs: 6000,
                  message: warning
                    ? warning
                    : t("students.matchedToast", {
                        email: student.email,
                        username: matched.username,
                      }),
                })
              }}
            />
          ) : null}

          <EditStudentButton
            org={org}
            classroom={classroom}
            student={student}
            selfReport={selfReport}
            onSaved={(updated) => {
              // Replace the edited row in the cached roster (see
              // useUpdateRosterCache). studentKey is stable across any permitted
              // edit — identity columns aren't editable, and an email-only row's
              // email (its only key) can't be changed — so the captured rowKey
              // still matches.
              updateRosterCache((current) =>
                current.map((s) =>
                  studentKey(s) === rowKey ? toStudent(updated) : s,
                ),
              )
              // A name/email change can affect invite display; keep parity with
              // the other row actions.
              invalidateInviteQueries()
            }}
          />

          <UnenrollStudentButton
            org={org}
            classroom={classroom}
            student={student}
            status={statusAvailable ? status : undefined}
            isSelf={isSelf}
            onRemoveStudent={(username: string, warning?: string) => {
              // Record only a real warning; a clean unenroll must not wipe one.
              if (warning) {
                setWarning(username, warning)
              }
              // Drop the row from the cached roster immediately (see
              // useUpdateRosterCache). Keyed by the same stable studentKey.
              updateRosterCache((current) => removeFromRoster(current, rowKey))
              // Unenroll may cancel a pending invite or remove a member.
              invalidateInviteQueries()
            }}
          />
        </div>
      </motion.li>
    )
  }

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Action results surface here at the top: the triggering section often
          unmounts afterward (e.g. confirming empties the Ready section). */}
      <div className="flex w-full flex-col gap-2">
        <AnimatePresence initial={false}>
          {reconcileSummary ? (
            <motion.div
              key="reconcile-summary"
              layout
              variants={collapseVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              role="alert"
              className="alert alert-info alert-soft overflow-hidden"
            >
              <span className="text-sm">
                {t("students.enrollmentSummary", { summary: reconcileSummary })}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => setReconcileSummary("")}
              >
                {t("students.dismiss")}
              </button>
            </motion.div>
          ) : null}

          {Object.entries(teamWarnings).map(([username, warning]) => (
            <motion.div
              key={username}
              layout
              variants={collapseVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              role="alert"
              className="alert alert-warning alert-soft overflow-hidden"
            >
              <span className="text-sm">{warning}</span>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => dismissWarning(username)}
              >
                {t("students.dismiss")}
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Wait on all partition queries to avoid an onboarded student flashing in
          "Awaiting enrollment" before jumping to "Ready". The Invite card still
          renders below so links are available while status loads. */}
      {!rosterReady ? (
        <div className="card card-border w-full bg-base-100 shadow-sm">
          <div className="flex items-center justify-center gap-3 px-6 py-12 text-base-content/70">
            <span
              className="loading loading-spinner loading-md"
              aria-hidden="true"
            />
            <span className="text-sm">{t("students.loadingRoster")}</span>
          </div>
        </div>
      ) : null}

      {/* Ready for enrollment confirmation (state 2). */}
      <AnimatePresence initial={false}>
        {rosterReady && readyToConfirm.length > 0 ? (
          <motion.div
            key="ready-to-confirm"
            layout
            variants={enterExit}
            initial="initial"
            animate="animate"
            exit="exit"
            className="card card-border w-full overflow-hidden border-info/30 bg-info/5 shadow-sm"
          >
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-info/20">
              <div className="flex flex-col">
                <h2 className="text-lg font-semibold text-info">
                  {t("students.readyHeading")}
                </h2>
                <span className="mt-0.5 text-sm text-base-content/70">
                  {t("students.readySubtitle", {
                    count: readyToConfirm.length,
                  })}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-primary shrink-0"
                onClick={() =>
                  void runReconcile(() => reconcileMutation.mutateAsync())
                }
                disabled={reconcileMutation.isPending}
              >
                <RefreshCw
                  aria-hidden="true"
                  className={`size-4 ${reconcileMutation.isPending ? "animate-spin" : ""}`}
                />
                {t("students.confirmEnrollment", {
                  count: readyToConfirm.length,
                })}
              </button>
            </div>
            <ul className="divide-y divide-base-300 bg-base-100">
              <AnimatePresence initial={false}>
                {readyToConfirm.map((student) => renderStudentRow(student))}
              </AnimatePresence>
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Invite students: share links. */}
      <div className="card card-border w-full overflow-hidden bg-base-100 shadow-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-base-300">
          <h2 className="text-lg font-semibold">
            {t("students.inviteStudents")}
          </h2>
        </div>
        <OnboardingLink org={org} classroom={classroom} />
        <InviteLink
          org={org}
          expanded={showGithubInvite}
          onToggle={() => setShowGithubInvite((prev) => !prev)}
        />

        {!statusAvailable ? (
          <div role="alert" className="alert alert-info alert-soft mx-6 my-4">
            <span className="text-sm">
              {t("students.inviteStatusOwnerOnly")}
            </span>
          </div>
        ) : null}

        {statusAvailable && reportsErrored ? (
          <div
            role="alert"
            className="alert alert-warning alert-soft mx-6 my-4"
          >
            <span className="text-sm">{t("students.reportsErrored")}</span>
          </div>
        ) : null}
      </div>

      {/* Awaiting enrollment (state 1): invited, not yet onboarded. */}
      <AnimatePresence initial={false}>
        {rosterReady && awaitingEnrollment.length > 0 ? (
          <motion.div
            key="awaiting-enrollment"
            layout
            variants={enterExit}
            initial="initial"
            animate="animate"
            exit="exit"
            className="card card-border w-full overflow-hidden bg-base-100 shadow-sm"
          >
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-base-300">
              <div className="flex flex-col">
                <h2 className="text-lg font-semibold">
                  {t("students.awaitingHeading")}
                </h2>
                <span className="mt-0.5 text-sm text-base-content/70">
                  {t("students.awaitingSubtitle")}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {statusAvailable ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setConfirmResendAllOpen(true)}
                  >
                    <Send aria-hidden="true" className="size-4" />
                    {t("students.resendInvites")}
                  </button>
                ) : null}
                <div className="badge badge-ghost badge-soft text-base">
                  {awaitingEnrollment.length}
                </div>
              </div>
            </div>
            <ul className="divide-y divide-base-300">
              <AnimatePresence initial={false}>
                {awaitingEnrollment.map((student) => renderStudentRow(student))}
              </AnimatePresence>
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Enrolled students (state 3) — reviewed last. */}
      {rosterReady ? (
        <EnterDiv className="card card-border w-full overflow-hidden bg-base-100 shadow-sm">
          <div className="flex items-center justify-between px-6 py-4 border-b border-base-300">
            <h2 className="text-lg font-semibold">
              {t("students.enrolledHeading")}
            </h2>
            <div className="flex items-center gap-3">
              {hasSections && enrolled.length > 0 && (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-base-content/70">
                  <input
                    type="checkbox"
                    className="toggle toggle-sm"
                    checked={groupBySection}
                    onChange={(e) => setGroupBySection(e.target.checked)}
                  />
                  {t("students.groupBySection")}
                </label>
              )}
              <div className="badge badge-primary badge-soft text-base">
                {enrolled.length}
              </div>
            </div>
          </div>
          {enrolled.length > 0 ? (
            groupBySection && hasSections ? (
              <div className="divide-y divide-base-300">
                {enrolledBySection.map(({ section, students: group }) => (
                  <div key={section}>
                    <div className="flex items-center justify-between bg-base-200/60 px-6 py-2">
                      <h3 className="text-sm font-semibold text-base-content/70">
                        {section === NO_SECTION
                          ? t("students.noSection")
                          : section}
                      </h3>
                      <span className="badge badge-ghost badge-sm">
                        {group.length}
                      </span>
                    </div>
                    <ul className="divide-y divide-base-300">
                      <AnimatePresence initial={false}>
                        {group.map((student) => renderStudentRow(student))}
                      </AnimatePresence>
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <ul className="divide-y divide-base-300">
                <AnimatePresence initial={false}>
                  {enrolled.map((student) => renderStudentRow(student))}
                </AnimatePresence>
              </ul>
            )
          ) : (
            <div className="px-6 py-10 text-center text-sm text-base-content/70">
              {t("students.noneEnrolled")}
            </div>
          )}
        </EnterDiv>
      ) : null}

      <ConfirmModal
        open={confirmResendAllOpen}
        title={t("students.resendAllTitle")}
        description={
          <>
            {t("students.resendAllBodyPrefix")}{" "}
            <span className="font-semibold text-base-content">
              {t("students.resendAllBodyEmphasis")}
            </span>
            {t("students.resendAllBodyMiddle")}{" "}
            <span className="font-semibold text-base-content">{org}</span> (
            <span className="font-semibold text-base-content">
              {nonMemberStudents.length}
            </span>{" "}
            {t("students.resendAllBodyStudents", {
              count: nonMemberStudents.length,
            })}
            ){t("students.resendAllBodySuffix")}
          </>
        }
        confirmText="resend"
        confirmLabel={t("students.resendInvites")}
        cancelLabel={t("common.cancel")}
        dangerous={false}
        needsConfirm={false}
        onConfirm={async () => {
          await handleResendAll()
        }}
        onClose={() => setConfirmResendAllOpen(false)}
      />
    </div>
  )
}

export default EnrolledStudents
