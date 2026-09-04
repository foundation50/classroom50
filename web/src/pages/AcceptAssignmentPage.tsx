import {
  AlertIcon,
  CalendarIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  LinkExternalIcon,
  LockIcon,
  MarkGithubIcon,
  PeopleIcon,
  PersonIcon,
} from "@/components/ui/icons"

import { Spinner } from "@/components/Spinner"
import {
  Alert,
  Badge,
  Button,
  Card,
  Markdown,
  MonoLtr,
  Heading,
  RouterButton,
} from "@/components/ui"
import { assignmentDescription } from "@/types/classroom"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import type { GitHubUser } from "@/github-core/types"
import { GitHubAPIError } from "@/github-core/errors"
import { useParams, useSearch } from "@tanstack/react-router"
import { useAcceptAssignment } from "@/hooks/mutations/useAcceptAssignment"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import confetti from "canvas-confetti"
import { type AcceptStepId, type AcceptStepStatus } from "@/domain/assignments"
import {
  localizedMessageOf,
  resolveLocalizedMessage,
  errorText,
  type LocalizedMessage,
} from "@/types/localizedMessage"
import { useAcceptAndVerifyMembership } from "@/hooks/mutations/useAcceptAndVerifyMembership"
import {
  classifyMembershipError,
  MembershipError,
} from "@/components/MembershipError"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import { attemptedPagesAssignmentUrls } from "@/github-core/queries"
import { useClassroomEnrollment } from "@/hooks/useClassroomEnrollment"
import { isOwnerGitHubOrgRole } from "@/authz"
import { useClassroomSecret } from "@/hooks/useStudentClassrooms"
import { useSafeSubmit } from "@/hooks/useSafeSubmit"
import { formatDueDateTime, isPastDue } from "@/util/formatDate"
import {
  studentRepoName,
  groupRepoName,
  GROUP_REPO_SEGMENT,
} from "@/util/studentRepo"
import useGetRepo from "@/hooks/useGetRepo"
import useAssignmentRepoSetup from "@/hooks/useAssignmentRepoSetup"
import { useBeforeUnloadGuard } from "@/hooks/useBeforeUnloadGuard"
import useGetOwnOrgMembership from "@/hooks/useGetOwnOrgMembership"
import useMyGroupTeam from "@/hooks/useMyGroupTeam"
import useGroupTeams from "@/hooks/useGroupTeams"
import { useGroupTeamMembers } from "@/hooks/useGroupTeamMembers"
import { groupTeamUrl } from "@/domain/teams/groupTeams"
import { groupDisplayName } from "@/util/groupTeam"
import useCreateGroupTeam from "@/hooks/mutations/useCreateGroupTeam"
import { GroupCollaboratorsModal } from "@/components/modals/GroupCollaboratorsModal"
import { Input } from "@/components/ui"
import { errorText as resolveErrorText } from "@/types/localizedMessage"
import { GitHubStatusNote } from "@/components/GitHubStatusNote"
import { useOutageHint } from "@/lib/githubHealth"
import { EnterDiv } from "@/lib/motionComponents"
import { collapseVariants } from "@/lib/motion"
import { firstGrapheme } from "@/util/students"
import { AnimatePresence, motion } from "motion/react"

const initialsFor = (user: GitHubUser | null) => {
  const source = user?.name || user?.login || "?"
  return source
    .split(/\s|-/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => firstGrapheme(part).toUpperCase())
    .join("")
}

const AcceptCard = ({ children }: { children: React.ReactNode }) => {
  return (
    <Card shadow={false} className="w-200 max-w-full p-8">
      {children}
    </Card>
  )
}

// Every accept render branch wraps its content in this so the card stays
// centered in the viewport regardless of its height.
const AcceptLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="flex min-h-screen flex-col bg-base-100">
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
    <div className="flex gap-4 bg-base-100 p-4 rounded-box border border-base-300">
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
          <MarkGithubIcon aria-hidden="true" className="size-4" />
          <span>{username ?? t("accept.checkingUser")}</span>
        </div>
      </div>
    </div>
  )
}

// One scaffold for every terminal accept-page state (not found / load error /
// locked / closed / not enrolled): tone badge + title + body, optional detail
// sections, and the signed-in-as footer. One recipe, one source — the
// per-state components below only choose copy and detail content.
const AcceptErrorCard = ({
  tone,
  icon,
  badge,
  title,
  body,
  children,
  user,
}: {
  tone: "error" | "warning"
  icon: React.ReactNode
  badge: string
  title: string
  body: React.ReactNode
  children?: React.ReactNode
  user: GitHubUser | null
}) => {
  const { t } = useTranslation()
  return (
    <AcceptLayout>
      <AcceptCard>
        <Card.Body className="gap-8">
          <div>
            <Badge tone={tone} size="md" className="gap-2">
              {icon}
              {badge}
            </Badge>

            <Heading as="h1" variant="title-medium" className="mt-6">
              {title}
            </Heading>

            <p className="mt-2 text-base text-base-content/70">{body}</p>
          </div>

          {children}

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

// The red detail panel shared by the not-found and load-error cards.
const ErrorDetailPanel = ({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) => (
  <div className="rounded-box border border-error/20 bg-error/5 p-5">
    <div className="flex items-start gap-4">
      <div className="rounded-full bg-error/10 p-3 text-error">
        <AlertIcon aria-hidden="true" className="size-6" />
      </div>

      <div className="min-w-0">
        <div className="font-bold text-error">{title}</div>
        {children}
      </div>
    </div>
  </div>
)

const AssignmentNotFound = ({
  user,
  assignment,
}: {
  user: GitHubUser | null
  assignment?: string
}) => {
  const { t } = useTranslation()
  return (
    <AcceptErrorCard
      tone="error"
      icon={<AlertIcon aria-hidden="true" className="size-4" />}
      badge={t("accept.notFound.badge")}
      title={t("accept.notFound.title")}
      body={
        <Trans
          i18nKey="accept.notFound.body"
          values={{ assignment }}
          components={{
            assignment: <MonoLtr className="font-semibold text-base-content" />,
          }}
        />
      }
      user={user}
    >
      <ErrorDetailPanel title={t("accept.notFound.unableToLoad")}>
        <div className="mt-1 text-sm text-base-content/70">
          {t("accept.notFound.expectedSlug")}
        </div>

        <pre className="mt-3 overflow-x-auto rounded-field bg-base-100 p-3 text-sm">
          {assignment}
        </pre>
      </ErrorDetailPanel>

      <div className="rounded-box border border-base-300 bg-base-100 p-4 text-sm text-base-content/70">
        <Trans
          i18nKey="accept.notFound.checkUrl"
          components={{
            file: <MonoLtr className="text-base-content" />,
          }}
        />
      </div>
    </AcceptErrorCard>
  )
}

// Shown when the published assignments manifest couldn't be LOADED at all —
// network failure, a CORS-blocked custom-domain redirect, a 404'd Pages site,
// or a malformed manifest. Distinct from AssignmentNotFound, which means the
// manifest loaded fine but lacks the slug. Renders the failure detail and the
// URL(s) attempted so a student's screenshot alone is diagnosable.
const AssignmentLoadError = ({
  user,
  assignment,
  error,
  urls,
  bootstrapUnknown,
}: {
  user: GitHubUser | null
  assignment?: string
  error: unknown
  urls: string[]
  // The teams read failed, so a custom Pages domain (if the classroom has
  // one) could not be discovered — the URL list may be incomplete.
  bootstrapUnknown?: boolean
}) => {
  const { t } = useTranslation()
  return (
    <AcceptErrorCard
      tone="error"
      icon={<AlertIcon aria-hidden="true" className="size-4" />}
      badge={t("accept.loadError.badge")}
      title={t("accept.loadError.title")}
      body={
        <Trans
          i18nKey="accept.loadError.body"
          values={{ assignment }}
          components={{
            assignment: <MonoLtr className="font-semibold text-base-content" />,
          }}
        />
      }
      user={user}
    >
      <ErrorDetailPanel title={t("accept.loadError.detailTitle")}>
        <div className="mt-1 text-sm text-base-content/70">
          {errorText(t, error)}
        </div>

        <div className="mt-3 text-sm text-base-content/70">
          {t("accept.loadError.urlsLabel")}
        </div>

        <pre className="mt-1 overflow-x-auto rounded-field bg-base-100 p-3 text-sm">
          {urls.join("\n")}
        </pre>

        {bootstrapUnknown && (
          <div className="mt-3 text-sm text-base-content/70">
            {t("accept.loadError.bootstrapUnknown")}
          </div>
        )}
      </ErrorDetailPanel>

      <div className="rounded-box border border-base-300 bg-base-100 p-4 text-sm text-base-content/70">
        {t("accept.loadError.retryHint")}
      </div>
    </AcceptErrorCard>
  )
}

// Shown when the requested assignment is locked. A locked assignment is closed
// to every student (see the Assignment.locked contract), so the accept CTA and
// mutation are never reached — this is a terminal state, not a retryable error.
const AssignmentLocked = ({
  user,
  assignment,
}: {
  user: GitHubUser | null
  assignment?: string
}) => {
  const { t } = useTranslation()
  return (
    <AcceptErrorCard
      tone="warning"
      icon={<LockIcon aria-hidden="true" className="size-4" />}
      badge={t("accept.locked.badge")}
      title={t("accept.locked.title")}
      body={
        <Trans
          i18nKey="accept.locked.body"
          values={{ assignment }}
          components={{
            assignment: <MonoLtr className="font-semibold text-base-content" />,
          }}
        />
      }
      user={user}
    />
  )
}

// Shown when the submission window is CLOSED and the viewer has not already
// accepted. Unlike locked, closed only blocks a NEW accept: an already-accepted
// student never reaches here (the gate checks repoExistsAlready), so they keep
// their repo and the usual already-accepted view. Terminal, not retryable.
const AssignmentClosed = ({
  user,
  assignment,
}: {
  user: GitHubUser | null
  assignment?: string
}) => {
  const { t } = useTranslation()
  return (
    <AcceptErrorCard
      tone="warning"
      icon={<CalendarIcon aria-hidden="true" className="size-4" />}
      badge={t("accept.closed.badge")}
      title={t("accept.closed.title")}
      body={
        <Trans
          i18nKey="accept.closed.body"
          values={{ assignment }}
          components={{
            assignment: <MonoLtr className="font-semibold text-base-content" />,
          }}
        />
      }
      user={user}
    />
  )
}

// classroom (not on the `classroom50-<classroom>` student team) and holds no
// staff role. Enrollment is derived from live team-membership reads, the same
// signal roster/role resolution uses; a student can't read classroom.json, so
// the slug is derived (a miss reads as non-member — never false access). This
// is a listing-and-flow guard consistent with the client-side model: the hard
// boundary for a private template is still GitHub's own template permission.
// Kept intentionally terse — it states the assignment isn't available without
// explaining the enrollment mechanics.
const NotEnrolled = ({ user }: { user: GitHubUser | null }) => {
  const { t } = useTranslation()
  return (
    <AcceptErrorCard
      tone="warning"
      icon={<LockIcon aria-hidden="true" className="size-4" />}
      badge={t("accept.notEnrolled.badge")}
      title={t("accept.notEnrolled.title")}
      body={t("accept.notEnrolled.body")}
      user={user}
    />
  )
}

// Team mode, teacher formation: the viewer isn't on any of this assignment's
// groups yet. The teacher forms the groups, so accepting is blocked until the
// teacher adds them — a waiting state, not an error.
const TeamNotAssigned = ({ user }: { user: GitHubUser | null }) => {
  const { t } = useTranslation()
  return (
    <AcceptErrorCard
      tone="warning"
      icon={<PersonIcon aria-hidden="true" className="size-4" />}
      badge={t("accept.teamBlocked.badge")}
      title={t("accept.teamBlocked.title")}
      body={t("accept.teamBlocked.body")}
      user={user}
    />
  )
}

// Team mode, student formation: the viewer is on no group yet, so the first
// step is founding one (they become the team maintainer and can add roster
// teammates). On success the my-team cache refreshes and the page falls
// through to the normal accept flow.
const CreateGroupCard = ({
  org,
  classroom,
  assignment,
  assignmentName,
  maxGroupSize,
  username,
  user,
  onRecheck,
  recheckPending = false,
}: {
  org: string
  classroom: string
  assignment: string
  assignmentName?: string
  maxGroupSize?: number
  username?: string
  user: GitHubUser | null
  // Re-runs the viewer's own-team resolution — the "I was approved on GitHub,
  // check again" affordance under the join list.
  onRecheck?: () => void
  recheckPending?: boolean
}) => {
  const { t } = useTranslation()
  const [displayName, setDisplayName] = useState("")
  const createTeam = useCreateGroupTeam({ org, classroom, assignment })
  // Student-formed teams are closed (visible), so classmates can browse them
  // here and request to join through GitHub's native flow — the REST API
  // exposes no join requests, so requesting, cancelling, and reviewing all
  // happen on the team's GitHub page.
  const teamsQuery = useGroupTeams(org, classroom, assignment)
  const teams = teamsQuery.data ?? []
  const { membersBySlug } = useGroupTeamMembers(
    org,
    teams.map((team) => team.slug),
  )
  // An org that restricts team creation to owners 403s the create; name that
  // case for the student instead of surfacing GitHub's raw message.
  const createError = createTeam.error
    ? createTeam.error instanceof GitHubAPIError && createTeam.error.isForbidden
      ? t("accept.createGroup.createForbidden")
      : resolveErrorText(t, createTeam.error)
    : null

  return (
    <AcceptLayout>
      <AcceptCard>
        <Card.Body className="gap-6">
          <div>
            <Badge tone="primary" size="md" className="gap-2">
              <PersonIcon aria-hidden="true" className="size-4" />
              {t("accept.modeTeam")}
            </Badge>
            <Heading as="h1" variant="title-medium" className="mt-6">
              {assignmentName}
            </Heading>
            <p className="mt-2 text-base text-base-content/70">
              {maxGroupSize
                ? t("accept.createGroup.body", { max: maxGroupSize })
                : t("accept.createGroup.bodyNoMax")}
            </p>
          </div>

          {createError ? (
            <Alert tone="error" className="text-sm">
              {createError}
            </Alert>
          ) : null}

          {teams.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="label p-0 text-sm font-medium">
                {t("accept.joinGroup.title")}
              </span>
              <ul className="divide-y divide-base-200 rounded-box border border-base-200">
                {teams.map((team) => {
                  const members = membersBySlug.get(team.slug)
                  const count = members?.length
                  const isFull =
                    maxGroupSize !== undefined &&
                    count !== undefined &&
                    count >= maxGroupSize
                  return (
                    <li
                      key={team.slug}
                      className="flex items-center gap-3 px-4 py-2.5"
                    >
                      <PeopleIcon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-base-content/70"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {groupDisplayName(team, t)}
                      </span>
                      <span className="text-xs text-base-content/70">
                        {count === undefined
                          ? "—"
                          : maxGroupSize !== undefined
                            ? t("accept.joinGroup.memberCountOfMax", {
                                count,
                                max: maxGroupSize,
                              })
                            : t("accept.joinGroup.memberCount", { count })}
                      </span>
                      {isFull ? (
                        <Badge ghost>{t("accept.joinGroup.full")}</Badge>
                      ) : (
                        <Button
                          as="a"
                          href={groupTeamUrl(org, team.slug)}
                          target="_blank"
                          rel="noreferrer"
                          variant="outline"
                          size="sm"
                        >
                          {t("accept.joinGroup.request")}
                          <LinkExternalIcon
                            aria-hidden="true"
                            className="size-3.5"
                          />
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
              <p className="text-xs text-base-content/70">
                {t("accept.joinGroup.help")}
              </p>
              {onRecheck && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-fit"
                  disabled={recheckPending}
                  loading={recheckPending}
                  onClick={onRecheck}
                >
                  {t("accept.joinGroup.recheck")}
                </Button>
              )}
              <div className="divider my-0">{t("accept.joinGroup.or")}</div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label
              className="label p-0 text-sm font-medium"
              htmlFor="group-display-name"
            >
              {t("accept.createGroup.nameLabel")}
            </label>
            <Input
              id="group-display-name"
              value={displayName}
              maxLength={80}
              placeholder={t("accept.createGroup.namePlaceholder")}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <p className="text-xs text-base-content/70">
              {t("accept.createGroup.nameHelp")}
            </p>
          </div>

          <Button
            variant="primary"
            className="w-full text-lg p-5"
            disabled={!username || createTeam.isPending}
            loading={createTeam.isPending}
            loadingLabel={t("accept.createGroup.createButton")}
            onClick={() =>
              createTeam.mutate({
                displayName: displayName.trim() || undefined,
                creatorLogin: username ?? "",
                founderLogin: username ?? "",
                formation: "student",
              })
            }
          >
            {t("accept.createGroup.createButton")}
          </Button>

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
  team: "accept.modeTeam",
}

// Pending-state placeholders. Once a step emits, the domain sends the same
// `accept.steps.*` key back as a { key, params } descriptor — one source of
// truth for every step label (see AGENTS.md's `{ key, params }` rule).
// Team-mode accepts insert the group-resolution step after the assignment
// lookup; other modes never emit it, so it's omitted from their checklist.
const acceptStepOrder = (
  isTeam: boolean,
): { id: AcceptStepId; labelKey: string }[] => [
  { id: "account", labelKey: "accept.steps.account" },
  { id: "membership", labelKey: "accept.steps.membership" },
  { id: "assignment", labelKey: "accept.steps.assignment" },
  ...(isTeam
    ? [{ id: "team" as AcceptStepId, labelKey: "accept.steps.team" }]
    : []),
  { id: "autograder", labelKey: "accept.steps.autograder" },
  { id: "repo", labelKey: "accept.steps.repo" },
  { id: "setup", labelKey: "accept.steps.setup" },
  { id: "feedback", labelKey: "accept.steps.feedback" },
  { id: "access", labelKey: "accept.steps.access" },
]

const ALL_ACCEPT_STEP_IDS: AcceptStepId[] = [
  "account",
  "membership",
  "assignment",
  "team",
  "autograder",
  "repo",
  "setup",
  "feedback",
  "access",
]

type StepState = Record<
  AcceptStepId,
  {
    status: AcceptStepStatus
    message?: LocalizedMessage
    error?: LocalizedMessage
  }
>

const initialStepState: StepState = Object.fromEntries(
  ALL_ACCEPT_STEP_IDS.map((id) => [id, { status: "pending" as const }]),
) as StepState

const StatusIcon = ({ status }: { status: AcceptStepStatus }) => {
  if (status === "complete")
    return (
      <CheckCircleIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-success"
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
      <AlertIcon aria-hidden="true" className="size-4 shrink-0 text-error" />
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
  const { t } = useTranslation()
  const deferred = state.error ?? state.message
  const text = deferred ? resolveLocalizedMessage(t, deferred) : label

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

const AcceptProgress = ({
  steps,
  order,
}: {
  steps: StepState
  order: { id: AcceptStepId; labelKey: string }[]
}) => {
  const { t } = useTranslation()
  const stepStates = order.map((step) => steps[step.id])
  const completed = stepStates.filter((s) => s.status === "complete").length
  const hasError = stepStates.some((s) => s.status === "error")
  const allDone = completed === order.length
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
    <div className="rounded-box border border-base-300 bg-base-100">
      <button
        type="button"
        onClick={() => setUserOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 p-4 text-start"
      >
        <span className="flex items-center gap-3">
          <CircularProgress
            completed={completed}
            total={order.length}
            status={headerStatus}
            label={t("accept.progress.count", {
              completed,
              total: order.length,
            })}
          />
          <span className="font-medium">{summary}</span>
        </span>

        <ChevronDownIcon
          aria-hidden="true"
          className={`size-4 shrink-0 text-base-content/70 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-base-300 p-5">
          {order.map((step) => (
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
    <div className="rounded-box border border-base-300 bg-base-100">
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-medium"
      >
        <span>{t("accept.repair.havingTrouble")}</span>
        <ChevronDownIcon
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
  const linkSecret =
    typeof search.k === "string" && search.k !== "" ? search.k : undefined

  // Bootstrap record from the student's own team description. Also the
  // fallback secret source for a bare accept link (no ?k=) — but read ALWAYS
  // (even when the link carries ?k=) because the custom Pages base URL for an
  // org off the github.io default is only discoverable here, never in the link.
  const {
    secret: teamSecret,
    pagesBaseUrl,
    isLoading: loadingSecret,
    isError: bootstrapError,
  } = useClassroomSecret(org, classroom)
  const secret = linkSecret ?? teamSecret

  const { user } = useGithubAuth()
  const username = user?.login

  // Enrollment gate: a student may only accept in a classroom they're enrolled
  // in (on the `classroom50-<classroom>` student team). Staff bypass via the
  // verdict; org owners bypass at the check below. Fail-OPEN on "unresolved" (a
  // settled-but-indeterminate team read) so a blip can't lock out a real
  // student — the domain membership step and GitHub's private-template
  // permission still gate. While the read is still in flight we hold the
  // spinner (loadingEnrollment below) rather than flashing the accept card and
  // then flipping to "not available".
  const { verdict: enrollmentVerdict, isLoading: loadingEnrollment } =
    useClassroomEnrollment(org, classroom, username)

  const {
    data: assignmentsData,
    isLoading: loadingAssignmentsData,
    error: assignmentsError,
  } = usePagesAssignments(org, classroom, secret, {
    enabled: !loadingSecret,
    pagesBaseUrl,
  })
  const loadingAssignments = loadingSecret || loadingAssignmentsData
  const {
    data: orgInvite,
    isLoading: loadingOrgMembership,
    error: orgMembershipError,
    refetch: refetchMembership,
  } = useGetOwnOrgMembership(org)

  const assignmentData = assignmentsData?.find((a) => a.slug === assignment)

  const pastDue = Boolean(assignmentData?.due && isPastDue(assignmentData.due))

  // Team mode: resolve MY group team before anything repo-shaped — the repo is
  // named after the team's counter, and a student on no team is blocked
  // (teacher formation) or offered the create-a-group flow (student formation).
  const isTeamMode = assignmentData?.mode === "team"
  const teamFormation = assignmentData?.team_formation ?? "teacher"
  const {
    data: myTeam,
    isLoading: loadingMyTeam,
    isError: myTeamError,
    refetch: refetchMyTeam,
    isFetching: fetchingMyTeam,
  } = useMyGroupTeam(org, classroom, assignment, {
    enabled: isTeamMode && Boolean(username),
  })

  const expectedRepoName = isTeamMode
    ? myTeam
      ? groupRepoName(classroom ?? "", assignment ?? "", myTeam.n)
      : // Placeholder counter until the team resolves; only rendered, never
        // queried (see repoLookupName).
        `${studentRepoName(classroom ?? "", assignment ?? "", GROUP_REPO_SEGMENT)}{n}`
    : username
      ? studentRepoName(classroom ?? "", assignment ?? "", username)
      : studentRepoName(
          classroom ?? "",
          assignment ?? "",
          "{your-github-username}",
        )

  // Only probe a repo name that's fully resolved: a team-mode student on no
  // team has no repo to check.
  const repoLookupName = isTeamMode && !myTeam ? "" : expectedRepoName

  const { data: checkedRepo, isLoading: isLoadingRepo } = useGetRepo(
    org,
    repoLookupName,
  )
  const repoExistsAlready =
    Boolean(repoLookupName) && checkedRepo?.name === repoLookupName

  // An existing repo isn't proof the accept finished (issue #502): the flow
  // can die between repo creation and the setup commit, leaving a repo that
  // clones fine but never autogrades. Probe the marker so the page can lead
  // with "Re-run setup" instead of a success-looking "Open repository". Wait
  // for the assignment to resolve first: an empty_repo assignment never writes
  // the marker, and the repo read can settle before the manifest does.
  const repoSetup = useAssignmentRepoSetup(org, repoLookupName, {
    enabled:
      repoExistsAlready &&
      assignmentData !== undefined &&
      assignmentData.empty_repo !== true,
  })

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
    pagesBaseUrl,
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
        // A heal re-run just landed the marker; drop the stale "incomplete"
        // verdict so the card flips to the healthy state.
        void repoSetup.refetch()
      },
    })
  }

  // The accept is a chain of GitHub writes with no rollback. Leaving mid-run
  // strands a repo the student can already push to but that never autogrades,
  // so hold the tab while any step is in flight.
  useBeforeUnloadGuard(acceptMutation.isPending)

  // The repo exists but the accept never finished. Cleared once a re-run
  // succeeds in this session (the mutation's data is the authoritative signal
  // until the marker probe refetches). Never raised for an empty_repo
  // assignment, whose repos legitimately carry no marker.
  const setupIncomplete =
    repoExistsAlready &&
    assignmentData?.empty_repo !== true &&
    repoSetup.state === "incomplete" &&
    !acceptMutation.isSuccess

  // Accept errors name their message ({ key, params }) rather than carrying
  // assembled English, so the remedy renders in the student's language. An error
  // with no descriptor (a browser network throw) falls back to the generic copy.
  const acceptError = localizedMessageOf(acceptMutation.error)

  if (
    loadingAssignments ||
    isLoadingRepo ||
    repoSetup.isLoading ||
    loadingOrgMembership ||
    loadingEnrollment ||
    (isTeamMode && loadingMyTeam)
  ) {
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

  // Not enrolled in this classroom (and not staff): the assignment isn't
  // available to this student. Org owners bypass (they administer every
  // classroom). Only a SETTLED "not-enrolled" verdict blocks; "unresolved"
  // falls through (fail-open).
  if (
    enrollmentVerdict === "not-enrolled" &&
    !isOwnerGitHubOrgRole(orgInvite.role)
  ) {
    return <NotEnrolled user={user} />
  }

  // The manifest couldn't be loaded at all (vs. loaded-but-slug-missing below).
  // Renders the failure and the exact URL(s) attempted so a screenshot is
  // enough to triage — see discussion #776, where a CORS-blocked custom-domain
  // redirect masqueraded as "assignment not found".
  if (assignmentsError) {
    return (
      <AssignmentLoadError
        user={user}
        assignment={assignment}
        error={assignmentsError}
        urls={attemptedPagesAssignmentUrls(
          org ?? "",
          classroom ?? "",
          secret,
          pagesBaseUrl,
        )}
        // A failed teams read means a custom Pages domain couldn't be
        // discovered (fail-open kept the fetch going on the default host);
        // say so instead of presenting the github.io URL as the whole story.
        bootstrapUnknown={bootstrapError && !pagesBaseUrl}
      />
    )
  }

  if (!assignmentData) {
    return <AssignmentNotFound user={user} assignment={assignment} />
  }

  if (assignmentData.locked) {
    return <AssignmentLocked user={user} assignment={assignment} />
  }

  // Closed only blocks a NEW accept. An already-accepted student (their repo
  // exists) still reaches the normal already-accepted view below.
  if (assignmentData.closed && !repoExistsAlready) {
    return <AssignmentClosed user={user} assignment={assignment} />
  }

  // Team mode with no group yet (a SETTLED null — a transient my-teams failure
  // falls through, and the accept flow's own team step surfaces a retryable
  // error instead of a wrongful block). Teacher formation waits for the
  // teacher; student formation founds a group first.
  if (isTeamMode && !myTeam && !myTeamError && username) {
    if (teamFormation === "student") {
      return (
        <CreateGroupCard
          org={org ?? ""}
          classroom={classroom ?? ""}
          assignment={assignment ?? ""}
          assignmentName={assignmentData.name}
          maxGroupSize={assignmentData.max_group_size}
          username={username}
          user={user}
          onRecheck={() => void refetchMyTeam()}
          recheckPending={fetchingMyTeam}
        />
      )
    }
    return <TeamNotAssigned user={user} />
  }

  const description = assignmentDescription(assignmentData)

  return (
    <AcceptLayout>
      <AcceptCard>
        <EnterDiv className="card-body gap-4">
          <div className="flex justify-between">
            <Badge tone="primary" size="md">
              <PersonIcon aria-hidden="true" className="size-4" />
              {assignmentData?.mode && modeLabelKey[assignmentData.mode]
                ? t(modeLabelKey[assignmentData.mode])
                : ""}
            </Badge>
            <Badge tone={pastDue ? "error" : "neutral"} size="md">
              {assignmentData?.due
                ? t(pastDue ? "accept.pastDue" : "accept.due", {
                    date: formatDueDateTime(assignmentData.due),
                  })
                : t("accept.noDueDate")}
            </Badge>
          </div>
          <Heading as="h1" variant="title-medium" className="pt-2">
            {assignmentData?.name}
          </Heading>
          <h2 className="text-lg">
            {repoExistsAlready
              ? t(
                  isTeamMode
                    ? "accept.alreadyAcceptedHeadingTeam"
                    : "accept.alreadyAcceptedHeading",
                )
              : t(
                  isTeamMode
                    ? "accept.acceptHeadingTeam"
                    : "accept.acceptHeading",
                )}
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

            <div className="flex gap-2 flex-col bg-base-100 p-4 rounded-box border border-base-300">
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

            {/* Upfront disclosure (issue #766): shown while the repo is yet to
                be created. Once it exists the notice would be stale — the
                accept step message carries the visibility that landed. */}
            {assignmentData.repo_visibility === "public" &&
              !repoExistsAlready &&
              !acceptMutation.data && (
                <Alert tone="warning" className="items-start">
                  <AlertIcon aria-hidden="true" className="size-5 shrink-0" />
                  <div>
                    <div className="font-bold">
                      {t("accept.publicRepo.title")}
                    </div>
                    <div className="mt-1 text-sm">
                      {t("accept.publicRepo.body")}
                    </div>
                  </div>
                </Alert>
              )}

            {(acceptMutation.isPending ||
              acceptMutation.isError ||
              acceptMutation.isSuccess) && (
              <AcceptProgress
                steps={steps}
                order={acceptStepOrder(isTeamMode)}
              />
            )}

            {acceptMutation.isPending && (
              <p className="text-sm text-base-content/70" role="status">
                {t("accept.keepTabOpen")}
              </p>
            )}

            {setupIncomplete && !acceptMutation.isPending && (
              <Alert tone="warning" className="items-start">
                <AlertIcon aria-hidden="true" className="size-5 shrink-0" />
                <div className="flex-1">
                  <div className="font-bold">
                    {t("accept.setupIncomplete.title")}
                  </div>
                  <div className="mt-1 text-sm">
                    {t("accept.setupIncomplete.body")}
                  </div>
                  <Button
                    variant="warning"
                    className="mt-3 w-full"
                    disabled={!username}
                    onClick={() => void runAccept(() => runAcceptFlow())}
                  >
                    {t("accept.repair.rerun")}
                  </Button>
                </div>
              </Alert>
            )}

            {acceptMutation.isError && (
              <Alert tone="error" className="items-start">
                <div>
                  <div className="font-bold">{t("accept.errorTitle")}</div>
                  <div className="mt-1 whitespace-pre-wrap text-sm">
                    {acceptError
                      ? resolveLocalizedMessage(t, acceptError)
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
                  // Audited exemption to the collapse-overflow guard: the surrounding
                  // conditional needs this AnimatePresence for the exit animation, and
                  // the permanent clip is safe because a stack of buttons/links paints
                  // no overlay outside its box.
                  // eslint-disable-next-line no-restricted-syntax
                  <motion.div
                    key="post-accept-actions"
                    variants={collapseVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="flex flex-col gap-4 overflow-hidden"
                  >
                    <Button
                      as="a"
                      // Demoted while setup is incomplete so the warning's
                      // "Re-run setup" reads as the one thing to do next.
                      variant={setupIncomplete ? "outline" : "primary"}
                      className="w-full text-lg p-5"
                      href={
                        acceptMutation?.data?.repo.html_url ||
                        `https://www.github.com/${org}/${checkedRepo?.name}`
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("accept.openRepository")}
                    </Button>

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
                      // outline variant (primary outline) aligns this with its
                      // Edit-collaborators sibling above; it was a bare neutral
                      // outline before.
                      <RouterButton
                        to="/$org/$classroom"
                        params={{ org, classroom }}
                        variant="outline"
                        className="w-full text-lg p-5"
                      >
                        {t("accept.goToClassroom")}
                      </RouterButton>
                    )}
                  </motion.div>
                )}
            </AnimatePresence>

            {/* Team mode: group management lives on the dedicated Manage
                group view (the assignment settings student branch), so the
                accept card stays a lightweight confirmation — one button in
                the post-accept action stack instead of an inline panel. */}
            {isTeamMode &&
              myTeam &&
              (acceptMutation.data || repoExistsAlready) &&
              !acceptMutation.isPending &&
              org &&
              classroom &&
              assignment && (
                <RouterButton
                  to="/$org/$classroom/assignments/$assignment/settings"
                  params={{ org, classroom, assignment }}
                  variant="outline"
                  className="w-full text-lg p-5"
                >
                  <PeopleIcon aria-hidden="true" className="size-5" />
                  {t("accept.manageGroupButton")}
                </RouterButton>
              )}

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
              !acceptMutation.isPending &&
              // The incomplete-setup warning already carries the re-run button.
              !setupIncomplete && (
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
