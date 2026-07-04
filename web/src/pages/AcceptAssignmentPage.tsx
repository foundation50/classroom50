import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  GraduationCap,
  Loader2,
  UserRound,
  UsersRound,
} from "lucide-react"

import GitHub from "@/assets/github.svg?react"
import GitHubWhite from "@/assets/github_white.svg?react"
import { Spinner } from "@/components/Spinner"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import type { GitHubUser } from "@/hooks/github/types"
import { Link, useParams, useSearch } from "@tanstack/react-router"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import confetti from "canvas-confetti"
import {
  acceptAssignment,
  type AcceptStepId,
  type AcceptStepStatus,
} from "@/api/mutations/assignments"
import { useAcceptAndVerifyMembership } from "@/hooks/onboarding/useAcceptAndVerifyMembership"
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
import { EnterDiv } from "@/lib/motionComponents"

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
  return (
    <div className="navbar bg-base-100 shadow-sm">
      <Link to="/">
        <div className="flex p-6 text-lg font-bold">
          <GraduationCap
            aria-hidden="true"
            className="size-8 text-primary mr-2"
          />{" "}
          {t("nav.appName")}
        </div>
      </Link>
    </div>
  )
}

const AcceptCard = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="card w-200 max-w-[calc(100vw-2em)] p-8 m-auto rounded-xl mt-10 border border-base-300">
      {children}
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
    <div className="min-h-screen bg-base-100">
      <AcceptNavbar />

      <AcceptCard>
        <div className="card-body gap-8">
          <div>
            <span className="badge badge-error badge-soft gap-2">
              <AlertTriangle aria-hidden="true" className="size-4" />
              {t("accept.notFound.badge")}
            </span>

            <h1 className="mt-6 text-2xl font-bold">
              {t("accept.notFound.title")}
            </h1>

            <p className="mt-2 text-base text-base-content/70">
              {t("accept.notFound.body_prefix")}{" "}
              <span className="font-mono font-semibold text-base-content">
                {assignment}
              </span>{" "}
              {t("accept.notFound.body_suffix")}
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
            {t("accept.notFound.checkUrl_prefix")}{" "}
            <span className="font-mono text-base-content">
              assignments.json
            </span>
            {t("accept.notFound.checkUrl_suffix")}
          </div>

          <div className="divider my-0" />

          <div className="space-y-3">
            <label className="label p-0 text-base font-semibold">
              {t("accept.signedInAs")}
            </label>

            <UserInfo user={user} />
          </div>
        </div>
      </AcceptCard>
    </div>
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
      <Loader2
        aria-hidden="true"
        className="size-5 shrink-0 animate-spin text-primary"
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

const AcceptProgress = ({ steps }: { steps: StepState }) => {
  const { t } = useTranslation()
  const stepStates = ACCEPT_STEP_ORDER.map((step) => steps[step.id])
  const completed = stepStates.filter((s) => s.status === "complete").length
  const hasError = stepStates.some((s) => s.status === "error")
  const isRunning = stepStates.some((s) => s.status === "running")
  const allDone = completed === ACCEPT_STEP_ORDER.length

  // Start collapsed — the header summary + count carries enough signal — and
  // let the student expand the per-step detail on demand. Force open only on
  // an error so a failure is never hidden. An explicit toggle takes precedence.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const expanded = userOpen ?? hasError

  const headerStatus: AcceptStepStatus = hasError
    ? "error"
    : allDone
      ? "complete"
      : isRunning
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
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <span className="flex items-center gap-3">
          <StatusIcon status={headerStatus} />
          <span className="font-medium">{summary}</span>
        </span>

        <span className="flex items-center gap-2 text-sm text-base-content/70">
          <span>
            {completed}/{ACCEPT_STEP_ORDER.length}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`size-4 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </span>
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
// primary "Open Repository" action.
const RepairToggle = ({
  disabled,
  onRerun,
}: {
  disabled: boolean
  onRerun: () => void
}) => {
  const { t } = useTranslation()
  return (
    <details className="group rounded-xl border border-base-300 bg-base-200/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-medium">
        <span>{t("accept.repair.havingTrouble")}</span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 transition-transform group-open:rotate-180"
        />
      </summary>

      <div className="border-t border-base-300 p-4">
        <p className="text-sm text-base-content/70">
          {t("accept.repair.hint")}
        </p>
        <button
          type="button"
          className="btn btn-outline btn-sm mt-3 w-full"
          disabled={disabled}
          onClick={onRerun}
        >
          {t("accept.repair.rerun")}
        </button>
      </div>
    </details>
  )
}

const AcceptAssignmentPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.acceptAssignment"))
  const { org, classroom, assignment } = useParams({ strict: false })
  // The capability key from the accept link (?k=...). For a protected
  // classroom this selects the <classroom>/<secret>/ Pages path; absent for
  // an unprotected classroom. Read loosely so the page also works if
  // mounted without the typed route in tests.
  const search = useSearch({ strict: false }) as { k?: string }
  const secret = typeof search.k === "string" ? search.k : undefined
  const client = useGitHubClient()

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
  const runAccept = useSafeSubmit()

  // A pending invitee opened the accept link before becoming an active member.
  // Rather than bouncing them to /onboard, accept + verify membership inline
  // (same shared verified-accept path), showing loading + error UI here, then
  // proceed to the accept flow once active.
  const isPending = orgInvite?.state === "pending"
  const membershipAccept = useAcceptAndVerifyMembership({
    org,
    enabled: Boolean(isPending && org),
  })

  const acceptMutation = useMutation({
    mutationFn: () => {
      setSteps(initialStepState)
      return acceptAssignment({
        client,
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
    },
    onSuccess: (result) => {
      // Celebrate a freshly created repo; an already-accepted repo isn't a new
      // milestone, so it skips the confetti.
      if (result.status === "created") {
        fireConfetti()
      }
    },
  })

  if (loadingAssignments || isLoadingRepo || loadingOrgMembership) {
    return (
      <div className="min-h-screen bg-base-100">
        <AcceptNavbar />
        <AcceptCard>
          <div className="flex justify-center">
            <Spinner size="xl" label={t("accept.loadingAssignment")} />
          </div>
        </AcceptCard>
      </div>
    )
  }

  // Membership read failed on the INITIAL read. Distinguish causes rather than a
  // blanket "not a member": classifyMembershipError routes a 403 + X-GitHub-SSO
  // to the SSO screen (with the authorize button when GitHub gave a URL, or the
  // url-less LMS/re-auth copy otherwise), a 404 to not-a-member, and anything
  // else to a retryable generic. (Transient 5xx/429 are retried by the query, so
  // they don't reach here as errors — and on any error the query's `data` is
  // undefined, so the pending auto-accept below is only reachable from a
  // successful read.)
  if (orgMembershipError) {
    const info = classifyMembershipError(orgMembershipError, {
      org,
      username,
    })
    return (
      <div className="min-h-screen bg-base-100">
        <AcceptNavbar />
        <AcceptCard>
          <MembershipError
            info={info}
            org={org}
            onRetry={() => void refetchMembership()}
          />
        </AcceptCard>
      </div>
    )
  }

  if (!orgInvite) {
    const info = classifyMembershipError(null, { org, username })
    return (
      <div className="min-h-screen bg-base-100">
        <AcceptNavbar />
        <AcceptCard>
          <MembershipError
            info={info}
            org={org}
            onRetry={() => void refetchMembership()}
          />
        </AcceptCard>
      </div>
    )
  }

  // Render the inline accept+verify while the pending invitee is being made
  // active: a cause-specific error (SSO / not-a-member / retryable) on failure,
  // otherwise a spinner until the hook reports active.
  if (isPending && !membershipAccept.isActive) {
    if (membershipAccept.isError) {
      const info = classifyMembershipError(membershipAccept.error, {
        org,
        username,
        membershipState: orgInvite.state,
      })
      return (
        <div className="min-h-screen bg-base-100">
          <AcceptNavbar />
          <AcceptCard>
            <MembershipError
              info={info}
              org={org}
              onRetry={membershipAccept.retry}
            />
          </AcceptCard>
        </div>
      )
    }
    return (
      <div className="min-h-screen bg-base-100">
        <AcceptNavbar />
        <AcceptCard>
          <div className="flex justify-center">
            <Spinner size="xl" label={t("accept.loadingAssignment")} />
          </div>
        </AcceptCard>
      </div>
    )
  }

  if (!assignmentData) {
    return <AssignmentNotFound user={user} assignment={assignment} />
  }

  return (
    <div className="min-h-screen bg-base-100">
      <AcceptNavbar />
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
                ? t("accept.due", {
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

          {pastDue && (
            <div className="alert alert-warning items-start">
              <AlertTriangle aria-hidden="true" className="size-5 shrink-0" />
              <div className="text-sm">{t("accept.pastDueWarning")}</div>
            </div>
          )}

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
                <GitHub aria-hidden="true" className="size-6 shrink-0" />
                <pre className="text-lg overflow-x-auto">
                  {org}/{expectedRepoName}
                </pre>
              </div>
            </div>

            {(acceptMutation.isPending ||
              acceptMutation.isError ||
              acceptMutation.isSuccess) && <AcceptProgress steps={steps} />}

            {acceptMutation.isError && (
              <div className="alert alert-error items-start">
                <AlertTriangle aria-hidden="true" className="size-5 shrink-0" />
                <div>
                  <div className="font-bold">{t("accept.errorTitle")}</div>
                  <div className="mt-1 whitespace-pre-wrap text-sm">
                    {acceptMutation.error instanceof Error
                      ? acceptMutation.error.message
                      : t("accept.errorGeneric")}
                  </div>
                  <div className="mt-2 text-xs opacity-80">
                    {t("accept.errorRetryHint")}
                  </div>
                </div>
              </div>
            )}

            {acceptMutation.data && (
              <div className="alert alert-success items-start">
                <CheckCircle2 aria-hidden="true" className="size-5 shrink-0" />
                <div className="min-w-0">
                  <div className="font-bold">
                    {acceptMutation.data.status === "already-accepted"
                      ? t("accept.alreadyAcceptedTitle")
                      : t("accept.acceptedTitle")}
                  </div>

                  <div className="mt-1">
                    {t("accept.repositoryLabel")}{" "}
                    <a
                      className="link font-mono"
                      href={acceptMutation.data.repo.html_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {acceptMutation.data.repo.full_name}
                    </a>
                  </div>
                </div>
              </div>
            )}

            {(acceptMutation.data || repoExistsAlready) && (
              <a
                className="btn btn-primary w-full text-xl p-6"
                href={
                  acceptMutation?.data?.repo.html_url ||
                  `https://www.github.com/${org}/${checkedRepo?.name}`
                }
                target="_blank"
                rel="noreferrer"
              >
                <GitHubWhite aria-hidden="true" className="size-6" />
                {t("accept.openRepository")}
              </a>
            )}

            {assignmentData?.mode === "group" &&
              (acceptMutation.data || repoExistsAlready) && (
                <button
                  type="button"
                  className="btn btn-outline w-full text-lg p-5"
                  onClick={() => setCollaboratorsOpen(true)}
                >
                  <UsersRound aria-hidden="true" className="size-5" />
                  {t("accept.editCollaborators")}
                </button>
              )}

            {!acceptMutation.data &&
              !repoExistsAlready &&
              !acceptMutation.isPending && (
                <button
                  type="button"
                  className="btn btn-primary w-full text-xl p-6"
                  disabled={!username || acceptMutation.isPending}
                  onClick={() =>
                    void runAccept(() => acceptMutation.mutateAsync())
                  }
                >
                  <GitHubWhite aria-hidden="true" className="size-6" />
                  {t("accept.acceptButton")}
                </button>
              )}

            {repoExistsAlready &&
              !acceptMutation.data &&
              !acceptMutation.isPending && (
                <RepairToggle
                  disabled={!username || acceptMutation.isPending}
                  onRerun={() =>
                    void runAccept(() => acceptMutation.mutateAsync())
                  }
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
    </div>
  )
}

export default AcceptAssignmentPage
