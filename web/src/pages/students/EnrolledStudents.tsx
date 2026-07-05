import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Pencil,
  RefreshCw,
  Send,
  Trash,
  UserRoundX,
} from "lucide-react"

import { nameFromParts, initialsFromParts } from "@/util/students"
import Avatar from "@/components/avatar"
import type { Student } from "@/types/classroom"
import { ConfirmModal } from "@/components/modals"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  syncRosterFromTeam,
  unenrollStudent,
  reconcileTeamFromOrgMembers,
} from "@/api/mutations/students"
import type { UnenrollStudentInput } from "@/api/mutations/students"
import { resendOrgInvitation, getErrorMessage } from "@/hooks/github/mutations"
import { useToast } from "@/context/notifications/NotificationProvider"
import { GitHubAPIError } from "@/hooks/github/errors"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import {
  githubKeys,
  invalidateInviteQueries as invalidateInviteQueriesForOrg,
} from "@/hooks/github/queries"
import { useUpdateRosterCache } from "@/hooks/useGetStudents"
import { useTeamRoster, useInvalidateTeamRoster } from "@/hooks/useTeamRoster"
import { rowToStudent, type TeamRosterRow } from "@/util/teamRoster"
import { studentKey, toStudent } from "@/util/roster"
import EditStudent from "@/pages/students/EditStudent"
import type { StudentCsvRow } from "@/api/mutations/students"
import { AnimatePresence, motion } from "motion/react"
import { collapseVariants, enterExit } from "@/lib/motion"
import { EnterDiv } from "@/lib/motionComponents"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

// Group rows by `section`, sorted by name with the unlabeled ("No section")
// bucket last. Generic over any row with a `section` field, so it serves both
// the CSV Student shape and the team-driven TeamRosterRow.
const NO_SECTION = "No section"
export function groupStudentsBySection<T extends { section?: string }>(
  students: T[],
): Array<{ section: string; students: T[] }> {
  const bySection = new Map<string, T[]>()
  for (const student of students) {
    const label = student.section?.trim() || NO_SECTION
    const bucket = bySection.get(label)
    if (bucket) bucket.push(student)
    else bySection.set(label, [student])
  }
  return Array.from(bySection.entries())
    .sort(([a], [b]) => {
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
  onSaved,
}: {
  org: string
  classroom: string
  student: Student
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
  isMember,
  isSelf = false,
  onRemoveStudent,
}: {
  org: string
  classroom: string
  student: Student
  isMember: boolean
  isSelf?: boolean
  onRemoveStudent: (username: string, teamWarning?: string) => void
}) => {
  const client = useGitHubClient()
  const { t } = useTranslation()
  const unenrollStudentMutation = useMutation({
    mutationFn: (input: UnenrollStudentInput) => unenrollStudent(client, input),
  })
  const [open, setOpen] = useState(false)
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

// Native GitHub org-invite link. This is how most students join: they accept
// the org invite directly on GitHub. Behind an expandable toggle; same org-wide
// URL for everyone.
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

// Classroom-wide /onboard link. A secondary/courtesy path (most students join
// by accepting the GitHub org invite directly): opening it accepts any pending
// org invite and verifies membership. Same URL for everyone, so no per-student
// token.
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
  const { notify } = useToast()
  const updateRosterCache = useUpdateRosterCache(org, classroom)
  const invalidateTeamRoster = useInvalidateTeamRoster(org, classroom)

  // Keyed by username/email so a clean action can't clobber another's warning.
  const [warnings, setWarnings] = useState<Record<string, string>>({})
  const [showGithubInvite, setShowGithubInvite] = useState(false)
  const [groupBySection, setGroupBySection] = useState(false)
  const [driftExpanded, setDriftExpanded] = useState(false)
  const [confirmResendAllOpen, setConfirmResendAllOpen] = useState(false)
  const [resendingKeys, setResendingKeys] = useState<Set<string>>(new Set())

  const {
    rows,
    counts,
    isLoading,
    isError,
    isEmpty,
    pendingHidden,
    teamSlug,
    csvMissingCount,
    notInOrgUsernames,
  } = useTeamRoster(org, classroom, students)

  const enrolled = useMemo(
    () => rows.filter((r) => r.state === "enrolled"),
    [rows],
  )
  const pending = useMemo(
    () => rows.filter((r) => r.state === "pending"),
    [rows],
  )
  const notInOrg = useMemo(
    () => rows.filter((r) => r.state === "not_in_org"),
    [rows],
  )

  const hasSections = useMemo(
    () => enrolled.some((r) => r.section.trim()),
    [enrolled],
  )
  const enrolledBySection = useMemo(
    () => groupStudentsBySection(enrolled),
    [enrolled],
  )

  const setWarning = (key: string, message: string) =>
    setWarnings((prev) => ({ ...prev, [key]: message }))
  const dismissWarning = (key: string) =>
    setWarnings((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })

  const invalidateInviteQueries = () =>
    invalidateInviteQueriesForOrg(queryClient, org)

  // Explicit teacher-triggered backfill: append missing team members into
  // students.csv as metadata (Section 5). Not automatic — the team-driven view
  // renders fine without it; this only persists optional metadata.
  const syncMutation = useMutation({
    mutationFn: () => syncRosterFromTeam(client, { org, classroom }),
    onSuccess: (result) => {
      notify({
        tone: "success",
        durationMs: 5000,
        message: result.noop
          ? t("students.syncUpToDate")
          : t("students.syncAdded", { count: result.addedUsernames.length }),
      })
      // CSV changed; invalidate the roster (csv-file) query so a refetch picks
      // up the appended metadata rows. Uses the same key useGetStudents reads (a
      // bare prefix wouldn't match).
      void queryClient.invalidateQueries({
        queryKey: githubKeys.csvFile(
          org,
          "classroom50",
          `${classroom}/students.csv`,
        ),
      })
    },
    onError: (err) => {
      notify({
        tone: "error",
        message: t("students.syncFailed", { error: getErrorMessage(err) }),
      })
    },
  })

  // Auto-sync on open: when team members lack a students.csv metadata row
  // (csvMissingCount > 0), append them automatically so the teacher needn't
  // press "Sync roster" for the common case. Reaching this component implies
  // config-repo write (RequireTeacher staff-gates the page).
  //
  // Fire once per drift episode: the ref latches after triggering so a re-render
  // (or the post-sync CSV refetch briefly showing >0) can't re-fire it, and it
  // re-arms only once count returns to 0. A failed auto-sync toasts (onError)
  // and, staying latched, does NOT retry in a loop — the teacher retries via the
  // now-enabled button.
  const autoSyncedRef = useRef(false)
  useEffect(() => {
    if (isLoading || isError) return
    if (csvMissingCount === 0) {
      autoSyncedRef.current = false // back in sync — re-arm for future drift.
      return
    }
    if (autoSyncedRef.current || syncMutation.isPending) return
    autoSyncedRef.current = true
    syncMutation.mutate()
    // syncMutation identity is stable (useMutation); the ref + count/loading
    // deps gate re-firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvMissingCount, isLoading, isError])

  // Auto-reconcile on open: a rostered student who joined the ORG (native invite
  // / SSO) but was never added to the classroom team renders as `not_in_org`.
  // Auto-reconcile simply tries to team-add every `not_in_org` username the
  // teacher put in students.csv (the teacher owns the CSV's accuracy); the
  // mutation team-adds the ones that are active org members and skips the rest,
  // which stay `not_in_org` and are highlighted below for invite/removal. The
  // team stays the enrollment source of truth; this touches neither org
  // membership nor the CSV.
  //
  // Latched exactly like auto-sync: fire once per drift episode, re-arm only
  // when the not_in_org set empties. A failed add toasts once and, staying
  // latched, does not retry in a loop.
  const reconcileMutation = useMutation({
    mutationFn: (usernames: string[]) =>
      reconcileTeamFromOrgMembers(client, { org, classroom, usernames }),
    onSuccess: (result) => {
      if (result.added.length > 0) {
        // Team membership changed; refresh the enrolled roster.
        invalidateTeamRoster()
        notify({
          tone: "success",
          durationMs: 5000,
          message: t("students.reconcileAdded", {
            count: result.added.length,
          }),
        })
      }
      if (result.failed.length > 0) {
        notify({
          tone: "warning",
          durationMs: 8000,
          message: t("students.reconcileFailed", {
            list: result.failed.map((f) => f.login).join(", "),
          }),
        })
      }
    },
    onError: (err) => {
      notify({
        tone: "error",
        message: t("students.reconcileError", { error: getErrorMessage(err) }),
      })
    },
  })

  const autoReconciledRef = useRef(false)
  const notInOrgCount = notInOrgUsernames.length
  useEffect(() => {
    if (isLoading || isError) return
    if (notInOrgCount === 0) {
      autoReconciledRef.current = false
      return
    }
    if (autoReconciledRef.current || reconcileMutation.isPending) return
    autoReconciledRef.current = true
    reconcileMutation.mutate(notInOrgUsernames)
    // reconcileMutation identity is stable; the ref + count/loading deps gate
    // re-firing. notInOrgCount (a number) is the stable dep — notInOrgUsernames
    // itself is read inside the effect for the payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notInOrgCount, isLoading, isError])

  const resendForRow = async (row: TeamRosterRow) => {
    const inviteeId = Number(row.github_id)
    if (!Number.isFinite(inviteeId) || inviteeId <= 0 || !row.username) {
      setWarning(
        row.key,
        t("students.resendMissingId", { username: row.username || row.email }),
      )
      return "skipped" as const
    }
    const result = await resendOrgInvitation(client, {
      org,
      username: row.username,
      inviteeId,
      invitationId: row.invitation_id,
    })
    return result.state
  }

  const handleResend = async (row: TeamRosterRow) => {
    setResendingKeys((prev) => new Set(prev).add(row.key))
    dismissWarning(row.key)
    try {
      await resendForRow(row)
      invalidateInviteQueries()
    } catch (err) {
      setWarning(
        row.key,
        t("students.resendFailed", {
          username: row.username || row.email,
          error: getErrorMessage(err),
        }),
      )
    } finally {
      setResendingKeys((prev) => {
        const next = new Set(prev)
        next.delete(row.key)
        return next
      })
    }
  }

  const handleResendAll = async () => {
    let resent = 0
    let skipped = 0
    const failures: string[] = []
    let rateLimited = false
    for (const row of pending) {
      try {
        const outcome = await resendForRow(row)
        if (outcome === "invited") resent++
        else skipped++
      } catch (err) {
        failures.push(row.username || row.email)
        if (err instanceof GitHubAPIError && err.isRateLimited) {
          rateLimited = true
          break
        }
      }
    }
    invalidateInviteQueries()
    const key = "__resend_all__"
    if (rateLimited) {
      setWarning(key, t("students.resendAllRateLimitedShort", { resent }))
    } else if (failures.length > 0) {
      setWarning(
        key,
        t("students.resendAllPartialShort", {
          resent,
          failed: failures.length,
          failedList: failures.join(", "),
        }),
      )
    } else if (resent === 0 && skipped > 0) {
      // Nothing was re-sent (e.g. every row lacked a resolvable invite id).
      // Don't report an unqualified success.
      setWarning(key, t("students.resendAllNothing", { count: skipped }))
    } else {
      setWarning(key, t("students.resendAllSuccess", { count: resent }))
    }
  }

  const onRowMetadataSaved = (rowKey: string, updated: StudentCsvRow) => {
    updateRosterCache((current) => {
      const next = current.map((s) =>
        studentKey(s) === rowKey ? toStudent(updated) : s,
      )
      // A member with no prior CSV row (blank metadata) has no row to replace;
      // append the new one so the edit sticks optimistically.
      const exists = current.some((s) => studentKey(s) === rowKey)
      return exists ? next : [...next, toStudent(updated)]
    })
    invalidateInviteQueries()
  }

  const renderRow = (row: TeamRosterRow) => {
    const student = rowToStudent(row)
    const displayName =
      nameFromParts(row.first_name, row.last_name) || row.username || row.email
    const displayHandle = row.username || row.email
    const displayInitials =
      initialsFromParts(row.first_name, row.last_name) ||
      (row.username || row.email)[0]?.toUpperCase() ||
      "?"
    const isResending = resendingKeys.has(row.key)
    const canResend = row.state === "pending" && Boolean(row.github_id)

    return (
      <motion.li
        key={row.key}
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
          {row.section.trim() ? (
            <span className="badge badge-sm badge-ghost shrink-0">
              {row.section.trim()}
            </span>
          ) : null}

          {row.state === "pending" ? (
            <span className="badge badge-sm badge-warning badge-soft shrink-0">
              {t("students.statusPending")}
            </span>
          ) : null}

          {row.state === "not_in_org" ? (
            <span className="badge badge-sm badge-ghost badge-soft shrink-0">
              {t("students.statusNotInOrg")}
            </span>
          ) : null}

          {canResend ? (
            <button
              type="button"
              className="btn btn-xs"
              disabled={isResending}
              aria-label={t("students.resendInviteAria", {
                username: row.username,
              })}
              onClick={() => void handleResend(row)}
            >
              {isResending ? (
                <span
                  className="loading loading-spinner loading-xs"
                  aria-hidden="true"
                />
              ) : (
                t("students.resend")
              )}
            </button>
          ) : null}

          {row.state === "pending" ? null : (
            <EditStudentButton
              org={org}
              classroom={classroom}
              student={student}
              onSaved={(updated) => onRowMetadataSaved(row.key, updated)}
            />
          )}

          <UnenrollStudentButton
            org={org}
            classroom={classroom}
            student={student}
            isMember={row.state === "enrolled"}
            onRemoveStudent={(_username, warning) => {
              if (warning) setWarning(row.key, warning)
              // Drop the CSV metadata row so nothing lingers as
              // not_in_org/pending, then refresh the enrolled list (unenroll
              // removed them from the classroom team).
              updateRosterCache((current) =>
                current.filter((s) => studentKey(s) !== row.key),
              )
              invalidateInviteQueries()
              invalidateTeamRoster()
            }}
          />
        </div>
      </motion.li>
    )
  }

  return (
    <div className="flex w-full flex-col gap-6">
      {/* Warnings / action results at the top. Rendered only when present so an
          empty container doesn't add a phantom gap. */}
      {Object.keys(warnings).length > 0 ? (
        <div className="flex w-full flex-col gap-2">
          <AnimatePresence initial={false}>
            {Object.entries(warnings).map(([key, warning]) => (
              <motion.div
                key={key}
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
                  onClick={() => dismissWarning(key)}
                >
                  {t("students.dismiss")}
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : null}

      {/* Data-drift banner: roster rows (with a username) not in the org and
          with no pending invite. Also shown below as a distinct section; this
          just surfaces the count + disclosure. */}
      {!isLoading && !isError && notInOrg.length > 0 ? (
        <div
          role="alert"
          className="alert alert-warning alert-soft flex-col items-start"
        >
          <div className="flex w-full items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm">
              <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
              {t("students.driftBanner", { count: notInOrg.length })}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              aria-expanded={driftExpanded}
              onClick={() => setDriftExpanded((v) => !v)}
            >
              {driftExpanded
                ? t("students.driftHide")
                : t("students.driftShow")}
            </button>
          </div>
          {driftExpanded ? (
            <ul className="mt-2 w-full list-disc pl-6 text-sm">
              {notInOrg.map((row) => (
                <li key={row.key}>
                  {nameFromParts(row.first_name, row.last_name) ||
                    row.username ||
                    row.email}
                  {row.username ? ` (@${row.username})` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Invite students card. */}
      <div className="card card-border w-full overflow-hidden bg-base-100 shadow-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-base-300">
          <h2 className="text-lg font-semibold">
            {t("students.inviteStudents")}
          </h2>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={syncMutation.isPending || csvMissingCount === 0}
            onClick={() => syncMutation.mutate()}
            title={
              csvMissingCount === 0
                ? t("students.syncInSyncTitle")
                : t("students.syncRosterTitle")
            }
          >
            <RefreshCw
              aria-hidden="true"
              className={`size-4 ${syncMutation.isPending ? "animate-spin" : ""}`}
            />
            {syncMutation.isPending
              ? t("students.syncing")
              : csvMissingCount === 0
                ? t("students.syncInSync")
                : t("students.syncRosterCount", { count: csvMissingCount })}
          </button>
        </div>
        <OnboardingLink org={org} classroom={classroom} />
        <InviteLink
          org={org}
          expanded={showGithubInvite}
          onToggle={() => setShowGithubInvite((prev) => !prev)}
        />
      </div>

      {isLoading ? (
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

      {isError ? (
        <div role="alert" className="alert alert-error alert-soft">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span className="text-sm">{t("students.rosterLoadError")}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: githubKeys.teamMembers(org, teamSlug),
              })
            }
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {t("students.rosterRetry")}
          </button>
        </div>
      ) : null}

      {isEmpty ? (
        <div className="card card-border w-full bg-base-100 shadow-sm">
          <div className="px-6 py-12 text-center">
            <h3 className="text-base font-semibold">
              {t("students.emptyTitle")}
            </h3>
            <p className="mt-2 text-sm text-base-content/70">
              {t("students.emptyBody")}
            </p>
          </div>
        </div>
      ) : null}

      {/* Pending invites. */}
      <AnimatePresence initial={false}>
        {!isLoading && !isError && pending.length > 0 ? (
          <motion.div
            key="pending"
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
                  {t("students.pendingHeading")}
                </h2>
                <span className="mt-0.5 text-sm text-base-content/70">
                  {t("students.pendingSubtitle")}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setConfirmResendAllOpen(true)}
                >
                  <Send aria-hidden="true" className="size-4" />
                  {t("students.resendInvites")}
                </button>
                <div className="badge badge-warning badge-soft text-base">
                  {counts.pending}
                </div>
              </div>
            </div>
            <ul className="divide-y divide-base-300">
              <AnimatePresence initial={false}>
                {pending.map((row) => renderRow(row))}
              </AnimatePresence>
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Non-owner: pending invites are owner-only. */}
      {!isLoading && !isError && pendingHidden ? (
        <div role="alert" className="alert alert-info alert-soft">
          <span className="text-sm">{t("students.pendingOwnerOnly")}</span>
        </div>
      ) : null}

      {/* On the roster but not in the organization (visible, distinct state). */}
      <AnimatePresence initial={false}>
        {!isLoading && !isError && notInOrg.length > 0 ? (
          <motion.div
            key="not-in-org"
            layout
            variants={enterExit}
            initial="initial"
            animate="animate"
            exit="exit"
            className="card card-border w-full overflow-hidden border-warning/30 bg-warning/5 shadow-sm"
          >
            <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-warning/20">
              <div className="flex flex-col">
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <UserRoundX aria-hidden="true" className="size-5" />
                  {t("students.notInOrgHeading")}
                </h2>
                <span className="mt-0.5 text-sm text-base-content/70">
                  {t("students.notInOrgSubtitle")}
                </span>
              </div>
              <div className="badge badge-ghost badge-soft text-base">
                {counts.not_in_org}
              </div>
            </div>
            <ul className="divide-y divide-base-300 bg-base-100">
              <AnimatePresence initial={false}>
                {notInOrg.map((row) => renderRow(row))}
              </AnimatePresence>
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Enrolled (team members) — reviewed last. */}
      {!isLoading && !isError ? (
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
                {counts.enrolled}
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
                        {group.map((row) => renderRow(row))}
                      </AnimatePresence>
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <ul className="divide-y divide-base-300">
                <AnimatePresence initial={false}>
                  {enrolled.map((row) => renderRow(row))}
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
              {pending.length}
            </span>{" "}
            {t("students.resendAllBodyStudents", { count: pending.length })})
            {t("students.resendAllBodySuffix")}
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
