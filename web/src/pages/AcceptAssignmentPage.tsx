import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  GraduationCap,
  Languages,
  UserRound,
} from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import { Spinner } from "@/components/Spinner"
import { Alert, Button, Card, Markdown, MonoLtr } from "@/components/ui"
import { assignmentDescription } from "@/types/classroom"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import type { GitHubUser } from "@/github-core/types"
import { Link, useParams, useSearch } from "@tanstack/react-router"
import { useAcceptAssignment } from "@/hooks/mutations/useAcceptAssignment"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useId, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import confetti from "canvas-confetti"
import { type AcceptStepId, type AcceptStepStatus } from "@/domain/assignments"
import { useAcceptAndVerifyMembership } from "@/hooks/mutations/useAcceptAndVerifyMembership"
import {
  classifyMembershipError,
  MembershipError,
} from "@/components/MembershipError"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { formatDueDateTime, isPastDue } from "@/util/formatDate"
import { studentRepoName } from "@/util/studentRepo"
import useGetRepo from "@/hooks/useGetRepo"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import { GroupCollaboratorsModal } from "@/components/modals/GroupCollaboratorsModal"
import { LanguageDialog } from "@/components/LanguageDialog"
import { GitHubStatusNote } from "@/components/GitHubStatusNote"
import { useOutageHint } from "@/lib/githubHealth"
import { EnterDiv } from "@/lib/motionComponents"
import { collapseVariants } from "@/lib/motion"
import { AnimatePresence, motion } from "motion/react"

const initialsFor = (user: GitHubUser | null) => {
  const source = user?.name || user?.login || "?"
  return source
    .split(/\s|-/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
}

const AcceptNavbar = () => {
  const { t } = useTranslation()
  const langDialogRef = useRef<HTMLDialogElement>(null)
  const langDialogTitleId = useId()
  return (
    <div className="navbar bg-base-100 shadow-sm">
      <div className="flex-1">
        <Link to="/">
          <div className="flex p-6 text-lg font-bold">
            <GraduationCap
              aria-hidden="true"
              className="size-8 text-primary me-2"
            />{" "}
            {t("nav.appName")}
          </div>
        </Link>
      </div>
      <div className="flex-none pe-4">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          onClick={() => langDialogRef.current?.showModal()}
        >
          <Languages aria-hidden="true" className="size-5" />
          <span className="hidden sm:inline">{t("nav.language")}</span>
        </Button>
      </div>
      <LanguageDialog ref={langDialogRef} titleId={langDialogTitleId} />
    </div>
  )
}

const AcceptCard = ({ children }: { children: React.ReactNode }) => {
  return (
    <Card radius="xl" shadow={false} className="w-200 max-w-full p-8">
      {children}
    </Card>
  )
}

// Every accept render branch wraps its content in this so the card stays
// centered in the viewport regardless of its height.
const AcceptLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="flex min-h-screen flex-col bg-base-100">
      <AcceptNavbar />
      <div className="flex flex-1 items-center justify-center p-4">
        {children}
      </div>
    </div>
  )
}

const UserInfo = ({ user }: { user: GitHubUser | null }) => {
  const { t } = useTranslation()
  const username = user?.login
  const displayName = user?.name || user?.login || t("accept.githubUser")

  return (
    <div className="flex gap-4 bg-base-200 p-4 rounded-xl border border-base-300">
      <div className="avatar avatar-placeholder">
        {user?.avatar_url ? (
          <div className="w-12 rounded-full">
            <img
              src={user.avatar_url}
              alt={t("accept.avatarAlt", { name: displayName })}
            />
          </div>
        ) : (
          <div className="bg-base-200 text-black rounded-full w-12">
            <span>{initialsFor(user)}</span>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="font-medium text-base-content">{displayName}</div>

        <div className="flex items-center gap-1 text-sm text-base-content/70">
          <GitHub aria-hidden="true" className="size-4" />
          <span>{username ?? t("accept.checkingUser")}</span>
        </div>
      </div>
    </div>
  )
}

const AssignmentNotFound = ({
  user,
  assignment,
}: {
  user: GitHubUser | null
  assignment?: string
}) => {
  const { t } = useTranslation()
  return (
    <AcceptLayout>
      <AcceptCard>
        <Card.Body className="gap-8">
          <div>
            <span className="badge badge-error badge-soft gap-2">
              <AlertTriangle aria-hidden="true" className="size-4" />
              {t("accept.notFound.badge")}
            </span>

            <h1 className="mt-6 text-2xl font-bold">
              {t("accept.notFound.title")}
            </h1>

            <p className="mt-2 text-base text-base-content/70">
              <Trans
                i18nKey="accept.notFound.body"
                values={{ assignment }}
                components={{
                  assignment: (
                    <MonoLtr className="font-semibold text-base-content" />
                  ),
                }}
              />
            </p>
          </div>

          <div className="rounded-xl border border-error/20 bg-error/5 p-5">
            <div className="flex items-start gap-4">
              <div className="rounded-full bg-error/10 p-3 text-error">
                <AlertTriangle aria-hidden="true" className="size-6" />
              </div>

              <div className="min-w-0">
                <div className="font-bold text-error">
                  {t("accept.notFound.unableToLoad")}
                </div>

                <div className="mt-1 text-sm text-base-content/70">
                  {t("accept.notFound.expectedSlug")}
                </div>

                <pre className="mt-3 overflow-x-auto rounded-lg bg-base-100 p-3 text-sm">
                  {assignment}
                </pre>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-base-300 bg-base-200/40 p-4 text-sm text-base-content/70">
            <Trans
              i18nKey="accept.notFound.checkUrl"
              components={{
                file: <MonoLtr className="text-base-content" />,
              }}
            />
          </div>

          <div className="divider my-0" />

          <div className="space-y-3">
            <label className="label p-0 text-base font-semibold">
              {t("accept.signedInAs")}
            </label>

            <UserInfo user={user} />
          </div>
        </Card.Body>
      </AcceptCard>
    </AcceptLayout>
  )
}

const modeLabelKey: Record<string, string> = {
  individual: "accept.modeIndividual",
  group: "accept.modeGroup",
}

// Pending-state placeholders; once a step emits, the live withAcceptStep
// message (assignments.ts) overrides these, so they only need loose parity.
const ACCEPT_STEP_ORDER: { id: AcceptStepId; labelKey: string }[] = [
  { id: "account", labelKey: "accept.steps.account" },
  { id: "membership", labelKey: "accept.steps.membership" },
  { id: "assignment", labelKey: "accept.steps.assignment" },
  { id: "autograder", labelKey: "accept.steps.autograder" },
  { id: "repo", labelKey: "accept.steps.repo" },
  { id: "access", labelKey: "accept.steps.access" },
  { id: "setup", labelKey: "accept.steps.setup" },
]

type StepState = Record<
  AcceptStepId,
  { status: AcceptStepStatus; message?: string; error?: string }
>

const initialStepState: StepState = ACCEPT_STEP_ORDER.reduce((acc, step) => {
  acc[step.id] = { status: "pending" }
  return acc
}, {} as StepState)

const StatusIcon = ({ status }: { status: AcceptStepStatus }) => {
  if (status === "complete")
    return (
      <CheckCircle2
        aria-hidden="true"
        className="size-5 shrink-0 text-success"
      />
    )
  if (status === "running")
    return (
      <span
        aria-hidden="true"
        className="loading loading-dots loading-sm shrink-0 text-primary"
      />
    )
  if (status === "error")
    return (
      <AlertTriangle
        aria-hidden="true"
        className="size-5 shrink-0 text-error"
      />
    )
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <span className="size-2.5 rounded-full bg-base-300" />
    </span>
  )
}

const StepRow = ({
  label,
  state,
}: {
  label: string
  state: StepState[AcceptStepId]
}) => {
  const text = state.error ?? state.message ?? label

  return (
    <div className="flex items-center gap-3 text-sm">
      <StatusIcon status={state.status} />
      <span
        className={
          state.status === "pending"
            ? "text-base-content/70"
            : state.status === "error"
              ? "text-error"
              : "text-base-content/80"
        }
      >
        {text}
      </span>
    </div>
  )
}

// Ring fills proportionally with completed steps. Color tracks the header
// status so a failed run reads as error, a finished run as success.
const CircularProgress = ({
  completed,
  total,
  status,
  label,
}: {
  completed: number
  total: number
  status: AcceptStepStatus
  label: string
}) => {
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const isComplete = status === "complete"
  // Fill the ring completely once done so the checkmark sits inside a full ring.
  const ratio = total > 0 ? completed / total : 0
  const fraction = isComplete ? 1 : ratio
  const strokeClass =
    status === "error"
      ? "text-error"
      : isComplete
        ? "text-success"
        : "text-primary"
  // Dash length that comfortably exceeds the check mark's path length (~10),
  // so the mark is fully hidden (no peeking tips) until it strokes in on done.
  const checkLength = 12

  return (
    <span
      role="img"
      aria-label={label}
      className="relative inline-flex size-9 items-center justify-center"
    >
      <svg viewBox="0 0 20 20" className="size-full">
        <g transform="rotate(-90 10 10)">
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            strokeWidth="2.5"
            className="stroke-base-300"
          />
          <circle
            cx="10"
            cy="10"
            r={radius}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
            className={`${strokeClass} transition-[stroke-dashoffset] duration-500`}
            stroke="currentColor"
          />
        </g>
        <path
          d="M6.5 10.2l2.2 2.3 4.8-4.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-success transition-[stroke-dashoffset] delay-300 duration-300"
          strokeDasharray={checkLength}
          strokeDashoffset={isComplete ? 0 : checkLength}
        />
      </svg>
    </span>
  )
}

const AcceptProgress = ({ steps }: { steps: StepState }) => {
  const { t } = useTranslation()
  const stepStates = ACCEPT_STEP_ORDER.map((step) => steps[step.id])
  const completed = stepStates.filter((s) => s.status === "complete").length
  const hasError = stepStates.some((s) => s.status === "error")
  const allDone = completed === ACCEPT_STEP_ORDER.length
  // Between steps, the finishing step is already "complete" while the next
  // hasn't emitted "running" yet — a momentary gap where no step is running.
  // Treat that gap as running so the header doesn't flicker back to pending on
  // every step boundary. Excludes the all-done case so "in flight" stays true
  // to its name rather than relying on the consuming ternary's ordering.
  const inFlight =
    stepStates.some((s) => s.status === "running") ||
    (completed > 0 && !allDone)

  // Start collapsed (header summary + count is enough); let the student expand
  // detail on demand. Force open on error so a failure is never hidden; an
  // explicit toggle takes precedence.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const expanded = userOpen ?? hasError

  const headerStatus: AcceptStepStatus = hasError
    ? "error"
    : allDone
      ? "complete"
      : inFlight
        ? "running"
        : "pending"

  const summary = {
    error: t("accept.progress.error"),
    complete: t("accept.progress.complete"),
    running: t("accept.progress.running"),
    pending: t("accept.progress.pending"),
  }[headerStatus]

  return (
    <div className="rounded-xl border border-base-300 bg-base-200/40">
      <button
        type="button"
        onClick={() => setUserOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 p-4 text-start"
      >
        <span className="flex items-center gap-3">
          <CircularProgress
            completed={completed}
            total={ACCEPT_STEP_ORDER.length}
            status={headerStatus}
            label={t("accept.progress.count", {
              completed,
              total: ACCEPT_STEP_ORDER.length,
            })}
          />
          <span className="font-medium">{summary}</span>
        </span>

        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-base-content/70 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-base-300 p-5">
          {ACCEPT_STEP_ORDER.map((step) => (
            <StepRow
              key={step.id}
              label={t(step.labelKey)}
              state={steps[step.id]}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const fireConfetti = () => {
  const base = {
    spread: 80,
    startVelocity: 55,
    ticks: 200,
    zIndex: 1000,
    disableForReducedMotion: true,
  }
  confetti({ ...base, particleCount: 60, origin: { x: 0, y: 0 }, angle: -55 })
  confetti({ ...base, particleCount: 60, origin: { x: 1, y: 0 }, angle: -125 })
}

// Collapsed-by-default repair section for an already-accepted repo. Tucks the
// "Re-run setup" affordance behind a toggle so it doesn't compete with the
// primary "Open Repository" action. Controlled so the parent can hide the
// primary actions while it's open.
const RepairToggle = ({
  disabled,
  onRerun,
  open,
  onToggle,
}: {
  disabled: boolean
  onRerun: () => void
  open: boolean
  onToggle: (open: boolean) => void
}) => {
  const { t } = useTranslation()
  return (
    <div className="rounded-xl border border-base-300 bg-base-200/40">
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-medium"
      >
        <span>{t("accept.repair.havingTrouble")}</span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-base-300 p-4">
          <p className="text-sm text-base-content/70">
            {t("accept.repair.hint")}
          </p>
          <Button
            variant="warning"
            size="sm"
            className="mt-3 w-full"
            disabled={disabled}
            onClick={onRerun}
          >
            {t("accept.repair.rerun")}
          </Button>
        </div>
      )}
    </div>
  )
}

const AcceptAssignmentPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.acceptAssignment"))
  const { org, classroom, assignment } = useParams({ strict: false })
  // Capability key from the accept link (?k=...). For a protected classroom it
  // selects the <classroom>/<secret>/ Pages path; absent otherwise. Read
  // loosely so the page works if mounted without the typed route in tests.
  const search = useSearch({ strict: false }) as { k?: string }
  const secret = typeof search.k === "string" ? search.k : undefined

  const { user } = useGithubAuth()
  const username = user?.login

  const { data: assignmentsData, isLoading: loadingAssignments } =
    usePagesAssignments(org, classroom, secret)
  const {
    data: orgInvite,
    isLoading: loadingOrgMembership,
    error: orgMembershipError,
    refetch: refetchMembership,
  } = useGetOwnOrgMembership(org)

  const assignmentData = assignmentsData?.find((a) => a.slug === assignment)

  const pastDue = Boolean(assignmentData?.due && isPastDue(assignmentData.due))

  const expectedRepoName = username
    ? studentRepoName(classroom ?? "", assignment ?? "", username)
    : studentRepoName(
        classroom ?? "",
        assignment ?? "",
        "{your-github-username}",
      )

  const { data: checkedRepo, isLoading: isLoadingRepo } = useGetRepo(
    org,
    expectedRepoName,
  )
  const repoExistsAlready = checkedRepo?.name === expectedRepoName

  const [steps, setSteps] = useState<StepState>(initialStepState)
  const [collaboratorsOpen, setCollaboratorsOpen] = useState(false)
  const [repairOpen, setRepairOpen] = useState(false)
  const runAccept = useSafeSubmit()
  const outageHint = useOutageHint()

  // A pending invitee opened the accept link before becoming an active member.
  // Rather than bouncing to /onboard, accept + verify membership inline (shared
  // verified-accept path), then proceed to the accept flow once active.
  const isPending = orgInvite?.state === "pending"
  const membershipAccept = useAcceptAndVerifyMembership({
    org,
    enabled: Boolean(isPending && org),
  })

  const acceptMutation = useAcceptAssignment({
    org: org ?? "",
    classroom: classroom ?? "",
    assignmentSlug: assignment ?? "",
    secret,
    onStepUpdate: (update) =>
      setSteps((prev) => ({
        ...prev,
        [update.id]: {
          status: update.status,
          message: update.message,
          error: update.error,
        },
      })),
  })

  // Reset the per-step progress UI, run the accept, and celebrate a freshly
  // created repo. Step-reset + confetti are UI effects, so they live at the
  // call site; the hook owns the org-repos invalidation. Both accept buttons
  // (initial + repair rerun) go through this.
  const runAcceptFlow = () => {
    setSteps(initialStepState)
    return acceptMutation.mutateAsync(undefined, {
      onSuccess: (result) => {
        if (result.status === "created") {
          fireConfetti()
        }
      },
    })
  }

  if (loadingAssignments || isLoadingRepo || loadingOrgMembership) {
    return (
      <AcceptLayout>
        <Spinner size="xl" label={t("accept.loadingAssignment")} />
      </AcceptLayout>
    )
  }

  // Initial membership read failed. classifyMembershipError routes a 403 +
  // X-GitHub-SSO to the SSO screen (authorize button when GitHub gave a URL,
  // else url-less LMS/re-auth copy), a 404 to not-a-member, else a retryable
  // generic. (Transient 5xx/429 are retried by the query, so on any error
  // `data` is undefined and the pending auto-accept below stays unreachable.)
  if (orgMembershipError) {
    const info = classifyMembershipError(orgMembershipError, {
      org,
      username,
    })
    return (
      <AcceptLayout>
        <AcceptCard>
          <MembershipError
            info={info}
            org={org}
            onRetry={() => void refetchMembership()}
          />
        </AcceptCard>
      </AcceptLayout>
    )
  }

  if (!orgInvite) {
    const info = classifyMembershipError(null, { org, username })
    return (
      <AcceptLayout>
        <AcceptCard>
          <MembershipError
            info={info}
            org={org}
            onRetry={() => void refetchMembership()}
          />
        </AcceptCard>
      </AcceptLayout>
    )
  }

  // Inline accept+verify while the pending invitee is made active: a
  // cause-specific error (SSO / not-a-member / retryable) on failure, else a
  // spinner until the hook reports active.
  if (isPending && !membershipAccept.isActive) {
    if (membershipAccept.isError) {
      const info = classifyMembershipError(membershipAccept.error, {
        org,
        username,
        membershipState: orgInvite.state,
      })
      return (
        <AcceptLayout>
          <AcceptCard>
            <MembershipError
              info={info}
              org={org}
              onRetry={membershipAccept.retry}
            />
          </AcceptCard>
        </AcceptLayout>
      )
    }
    return (
      <AcceptLayout>
        <Spinner size="xl" label={t("accept.loadingAssignment")} />
      </AcceptLayout>
    )
  }

  if (!assignmentData) {
    return <AssignmentNotFound user={user} assignment={assignment} />
  }

  const description = assignmentDescription(assignmentData)

  return (
    <AcceptLayout>
      <AcceptCard>
        <EnterDiv className="card-body gap-4">
          <div className="flex justify-between">
            <span className="badge badge-primary badge-soft">
              <UserRound aria-hidden="true" className="size-4" />
              {assignmentData?.mode && modeLabelKey[assignmentData.mode]
                ? t(modeLabelKey[assignmentData.mode])
                : ""}
            </span>
            <span
              className={`badge ${pastDue ? "badge-error badge-soft" : ""}`}
            >
              {assignmentData?.due
                ? t(pastDue ? "accept.pastDue" : "accept.due", {
                    date: formatDueDateTime(assignmentData.due),
                  })
                : t("accept.noDueDate")}
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight pt-2">
            {assignmentData?.name}
          </h1>
          <h2 className="text-lg">
            {repoExistsAlready
              ? t("accept.alreadyAcceptedHeading")
              : t("accept.acceptHeading")}
          </h2>

          {description ? (
            <details className="collapse collapse-arrow border border-base-300 bg-base-100">
              <summary className="collapse-title min-h-0 px-4 py-3 text-sm font-medium">
                {t("accept.descriptionLabel")}
              </summary>
              <div className="collapse-content max-h-80 overflow-y-auto">
                <Markdown content={description} />
              </div>
            </details>
          ) : null}

          <div className="divider my-0" />

          <label className="label text-lg">{t("accept.signedInAs")}</label>

          <div className="flex flex-col gap-4">
            <UserInfo user={user} />

            <div className="flex gap-2 flex-col bg-base-200 p-4 rounded-xl border border-base-300">
              <label className="label text-lg">
                {repoExistsAlready
                  ? t("accept.repoAlreadyExists")
                  : t("accept.repoWillBeCreated")}
              </label>

              <div className="flex gap-4 min-w-0">
                <pre className="text-lg overflow-x-auto">
                  <span className="font-bold">{org}</span>/{expectedRepoName}
                </pre>
              </div>
            </div>

            {(acceptMutation.isPending ||
              acceptMutation.isError ||
              acceptMutation.isSuccess) && <AcceptProgress steps={steps} />}

            {acceptMutation.isError && (
              <Alert tone="error" className="items-start">
                <AlertTriangle aria-hidden="true" className="size-5 shrink-0" />
                <div>
                  <div className="font-bold">{t("accept.errorTitle")}</div>
                  <div className="mt-1 whitespace-pre-wrap text-sm">
                    {acceptMutation.error instanceof Error
                      ? acceptMutation.error.message
                      : t("accept.errorGeneric")}
                  </div>
                  {outageHint.isOutage(acceptMutation.error) && (
                    <div className="mt-2 text-sm">
                      <GitHubStatusNote
                        statusDescription={outageHint.statusDescription}
                      />
                    </div>
                  )}
                  <div className="mt-2 text-xs opacity-80">
                    {t("accept.errorRetryHint")}
                  </div>
                </div>
              </Alert>
            )}

            <AnimatePresence initial={false}>
              {(acceptMutation.data || repoExistsAlready) &&
                !acceptMutation.isPending &&
                !repairOpen && (
                  <motion.div
                    key="post-accept-actions"
                    variants={collapseVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="flex flex-col gap-4 overflow-hidden"
                  >
                    <a
                      className="btn btn-primary w-full text-lg p-5"
                      href={
                        acceptMutation?.data?.repo.html_url ||
                        `https://www.github.com/${org}/${checkedRepo?.name}`
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("accept.openRepository")}
                    </a>

                    {assignmentData?.mode === "group" && (
                      <Button
                        variant="outline"
                        className="w-full text-lg p-5"
                        onClick={() => setCollaboratorsOpen(true)}
                      >
                        {t("accept.editCollaborators")}
                      </Button>
                    )}

                    {org && classroom && (
                      <Link
                        to="/$org/$classroom"
                        params={{ org, classroom }}
                        className="btn btn-outline w-full text-lg p-5"
                      >
                        {t("accept.goToClassroom")}
                      </Link>
                    )}
                  </motion.div>
                )}
            </AnimatePresence>

            {!acceptMutation.data &&
              !repoExistsAlready &&
              !acceptMutation.isPending && (
                <Button
                  variant="primary"
                  className="w-full text-lg p-5"
                  disabled={!username || acceptMutation.isPending}
                  onClick={() => void runAccept(() => runAcceptFlow())}
                >
                  {t("accept.acceptButton")}
                </Button>
              )}

            {(repoExistsAlready || acceptMutation.isError) &&
              !acceptMutation.data &&
              !acceptMutation.isPending && (
                <RepairToggle
                  disabled={!username || acceptMutation.isPending}
                  onRerun={() => {
                    setRepairOpen(false)
                    void runAccept(() => runAcceptFlow())
                  }}
                  open={repairOpen}
                  onToggle={setRepairOpen}
                />
              )}
          </div>
        </EnterDiv>
      </AcceptCard>

      {assignmentData?.mode === "group" &&
        username &&
        (acceptMutation.data?.repo.name || checkedRepo?.name) && (
          <GroupCollaboratorsModal
            open={collaboratorsOpen}
            onClose={() => setCollaboratorsOpen(false)}
            org={org ?? ""}
            repoName={acceptMutation.data?.repo.name || checkedRepo?.name || ""}
            repoUrl={
              acceptMutation.data?.repo.html_url || checkedRepo?.html_url
            }
            ownerLogin={username}
            assignmentName={assignmentData?.name}
            maxGroupSize={assignmentData?.max_group_size}
          />
        )}
    </AcceptLayout>
  )
}

export default AcceptAssignmentPage
