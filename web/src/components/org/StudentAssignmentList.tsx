import { Link } from "@tanstack/react-router"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import {
  CalendarClock,
  CheckCircle2,
  FilePlus2,
  UserRound,
  UsersRound,
} from "lucide-react"

import { Alert, Badge, Card } from "@/components/ui"
import { EmptyState } from "@/components/list"
import { EnterDiv } from "@/lib/motionComponents"
import { useGithubAuth } from "@/auth/useGithubAuth"
import usePagesAssignments from "@/hooks/usePagesAssignments"
import useGetOrgRepos from "@/hooks/useGetMyOrgRepos"
import { useStudentClassrooms } from "@/hooks/useStudentClassrooms"
import { studentRepoName } from "@/util/studentRepo"
import { formatDueDateTime, isPastDue } from "@/util/formatDate"
import type { Assignment } from "@/types/classroom"

// Resolve the classroom's capability secret for a student, config-free: the
// team-description bootstrap record (useStudentClassrooms) is the primary
// source; for a pre-schema team it falls back to any of the student's accepted
// repos' membership in this classroom (the caller passes that secret in). Empty
// when the classroom is listed (no secret needed).
function useClassroomSecret(
  org: string,
  classroom: string,
): string | undefined {
  const { classrooms } = useStudentClassrooms(org)
  return classrooms.find((c) => c.classroom === classroom)?.secret
}

function ModeBadge({ mode }: { mode: Assignment["mode"] }) {
  const { t } = useTranslation()
  if (mode === "group") {
    return (
      <Badge ghost className="gap-1">
        <UsersRound aria-hidden="true" className="size-3.5" />
        {t("assignments.discover.modeGroup")}
      </Badge>
    )
  }
  return (
    <Badge ghost className="gap-1">
      <UserRound aria-hidden="true" className="size-3.5" />
      {t("assignments.discover.modeIndividual")}
    </Badge>
  )
}

function DueBadge({ due }: { due?: string }) {
  const { t } = useTranslation()
  const overdue = due ? isPastDue(due) : false
  return (
    <Badge
      tone={overdue ? "error" : "neutral"}
      ghost={!overdue}
      className="gap-1"
    >
      <CalendarClock aria-hidden="true" className="size-3.5" />
      {due
        ? t("assignments.discover.due", { date: formatDueDateTime(due) })
        : t("assignments.discover.noDue")}
    </Badge>
  )
}

function AssignmentRow({
  org,
  classroom,
  assignment,
  accepted,
  secret,
}: {
  org: string
  classroom: string
  assignment: Assignment
  accepted: boolean
  secret?: string
}) {
  const { t } = useTranslation()
  return (
    <Card
      as={EnterDiv}
      radius="xl"
      bordered={false}
      shadow={false}
      className="col-span-12 border border-base-200 md:col-span-6"
    >
      <Card.Body className="gap-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-base font-semibold">
            {assignment.name || assignment.slug}
          </h3>
          {accepted && (
            <Badge tone="success" ghost className="shrink-0 gap-1">
              <CheckCircle2 aria-hidden="true" className="size-3.5" />
              {t("assignments.discover.accepted")}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ModeBadge mode={assignment.mode} />
          <DueBadge due={assignment.due} />
        </div>
        <Card.Actions className="pt-1">
          {accepted ? (
            <Link
              type="button"
              to="/$org/$classroom/assignments/$assignment/submission"
              params={{ org, classroom, assignment: assignment.slug }}
              className="btn btn-outline btn-primary btn-sm"
            >
              {t("assignments.discover.viewSubmission")}
            </Link>
          ) : (
            <Link
              type="button"
              to="/$org/$classroom/assignments/$assignment/accept"
              params={{ org, classroom, assignment: assignment.slug }}
              search={secret ? { k: secret } : undefined}
              className="btn btn-primary btn-sm"
            >
              <FilePlus2 aria-hidden="true" className="size-4" />
              {t("assignments.discover.accept")}
            </Link>
          )}
        </Card.Actions>
      </Card.Body>
    </Card>
  )
}

// The student's per-classroom assignment discovery list: every published
// assignment (not just accepted ones), each with the right CTA. The secret
// (team description, config-free) unlocks a protected classroom's Pages data
// even before the student accepts. A protected classroom whose secret is still
// unknown shows the invite-link fallback rather than a misleading empty list.
export function StudentAssignmentList({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) {
  const { t } = useTranslation()
  const { user } = useGithubAuth()
  const secret = useClassroomSecret(org, classroom)

  const {
    data: assignments,
    isLoading,
    isError,
  } = usePagesAssignments(org, classroom, secret)
  const { data: repos } = useGetOrgRepos(org)

  const acceptedSlugs = useMemo(() => {
    const set = new Set<string>()
    const login = user?.login
    if (!login) return set
    // Set of the student's own writable repo names, then match each assignment's
    // canonical repo name against it (one pass each — no nested filter).
    const writableNames = new Set(
      (repos ?? [])
        .filter((repo) => repo.permissions?.push)
        .map((repo) => repo.name.toLowerCase()),
    )
    for (const a of assignments ?? []) {
      if (writableNames.has(studentRepoName(classroom, a.slug, login))) {
        set.add(a.slug)
      }
    }
    return set
  }, [repos, assignments, classroom, user?.login])

  if (isLoading) {
    return (
      <div className="grid grid-cols-12 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="skeleton skeleton-shimmer col-span-12 h-36 rounded-xl md:col-span-6"
          />
        ))}
      </div>
    )
  }

  // A protected classroom whose secret we can't resolve (pre-schema team, not
  // yet accepted) 404s the Pages read. Guide the student to the invite link
  // rather than implying the classroom has no assignments.
  if (isError) {
    return (
      <Alert tone="info">
        <div>{t("assignments.discover.protectedNoSecret")}</div>
      </Alert>
    )
  }

  if (!assignments || assignments.length === 0) {
    return (
      <EmptyState
        title={t("assignments.discover.emptyTitle")}
        body={t("assignments.discover.emptyBody")}
      />
    )
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      {assignments.map((assignment) => (
        <AssignmentRow
          key={assignment.slug}
          org={org}
          classroom={classroom}
          assignment={assignment}
          accepted={acceptedSlugs.has(assignment.slug)}
          secret={secret}
        />
      ))}
    </div>
  )
}

export default StudentAssignmentList
