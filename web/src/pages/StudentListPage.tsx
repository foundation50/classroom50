import { useState } from "react"

import AddStudent from "@/pages/students/AddStudent"
import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import EnrolledStudents from "@/pages/students/EnrolledStudents"
import CsvRosterView from "@/pages/students/CsvRosterView"
import UploadRoster from "@/pages/students/UploadRoster"
import InviteLinksModal from "@/pages/students/InviteLinksModal"
import { GitHubLink } from "@/components/GitHubLink"
import { useParams } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import useGetStudents, { useUpdateRosterCache } from "@/hooks/useGetStudents"
import { useTeamRoster, useInvalidateTeamRoster } from "@/hooks/useTeamRoster"
import { useSuppressedLogins } from "@/hooks/useSuppressedLogins"
import { invalidateInviteQueries } from "@/github-core/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import RequireRole from "@/components/RequireRole"
import RoleResolvingFallback from "@/components/RoleResolvingFallback"
import { useIsOrgOwner } from "@/context/githubOrgRole/useIsOrgOwner"
import { CONFIG_REPO, DEFAULT_BRANCH } from "@/util/configRepo"
import { toStudent } from "@/util/roster"
import { rosterPath } from "@/util/rosterPath"
import { Badge } from "@/components/ui"
import { ROLE_BADGE_TONE } from "@/util/classroomRoleUI"
import { useTranslation } from "react-i18next"

// The team-driven roster: live GitHub membership, pending/failed invites, and
// every management action. Owner-only — it calls useTeamRoster (whose
// student-team read 403s for a non-owner) and the owner-only invite reads.
const TeamRosterContent = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const { t } = useTranslation()
  const { students, parseProblems, recheckRoster, rechecking } = useGetStudents(
    org,
    classroom,
  )
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const updateRosterCache = useUpdateRosterCache(org, classroom)
  const invalidateTeamRoster = useInvalidateTeamRoster(org, classroom)
  // Session-unenrolled logins, owned here so both the roster (which remembers on
  // unenroll and skips them in the auto-backfills) and the Add modal (which
  // forgets a login on a successful re-enroll) share one set — otherwise a
  // re-added student would stay suppressed until reload.
  const suppressedLogins = useSuppressedLogins()

  // Which add-students affordance is open (all mutually exclusive modals).
  const [addOpen, setAddOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)

  // Adding members enrolls people into the org and (for teacher/TA) grants
  // config-repo access — only an org owner can complete either, so non-owner
  // staff (TAs, non-owner teachers) never see the add affordances at all.
  const { isOwner } = useIsOrgOwner()

  // Counts from the team roster (same source as EnrolledStudents), so header
  // and list agree. Enrollment is team membership, not the CSV. The header shows
  // one union total (distinct enrolled people across the student + staff teams —
  // counts.enrolled, already de-duplicated per person) followed by a per-role
  // breakdown (roleCounts tallies each role a person holds).
  const {
    counts,
    roleCounts,
    isLoading: rosterLoading,
    isError: rosterError,
  } = useTeamRoster(org, classroom, students)
  const countReady = !rosterLoading && !rosterError
  // Per-role breakdown badges after the member total; each shown only when the
  // class has at least one enrolled member in that role.
  const showStudentCount = roleCounts.student > 0
  const showTeacherCount = roleCounts.teacher > 0
  const showHtaCount = roleCounts.hta > 0
  const showTaCount = roleCounts.ta > 0

  return (
    <>
      <PageHeader
        title={t("nav.roster")}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {countReady ? (
              <>
                <Badge tone="neutral" ghost className="shrink-0">
                  {t("students.membersEnrolledCount", {
                    count: counts.enrolled,
                  })}
                </Badge>
                {showStudentCount ? (
                  <Badge
                    tone={ROLE_BADGE_TONE.student}
                    ghost
                    className="shrink-0"
                  >
                    {t("students.roleStudentCount", {
                      count: roleCounts.student,
                    })}
                  </Badge>
                ) : null}
                {showTeacherCount ? (
                  <Badge tone={ROLE_BADGE_TONE.teacher} className="shrink-0">
                    {t("students.teacherCount", {
                      count: roleCounts.teacher,
                    })}
                  </Badge>
                ) : null}
                {showHtaCount ? (
                  <Badge tone={ROLE_BADGE_TONE.hta} className="shrink-0">
                    {t("students.headTaCount", { count: roleCounts.hta })}
                  </Badge>
                ) : null}
                {showTaCount ? (
                  <Badge tone={ROLE_BADGE_TONE.ta} className="shrink-0">
                    {t("students.taCount", { count: roleCounts.ta })}
                  </Badge>
                ) : null}
              </>
            ) : (
              <span>{t("students.enrolledCountLoading")}</span>
            )}
            <span aria-hidden="true" className="text-base-content/30">
              ·
            </span>
            <GitHubLink
              href={`https://github.com/${org}/${CONFIG_REPO}/blob/${DEFAULT_BRANCH}/${rosterPath(classroom)}`}
              label={t("students.viewCsvOnGitHub")}
              title={t("students.viewCsvOnGitHub")}
            />
          </span>
        }
      />

      <EnrolledStudents
        students={students}
        parseProblems={parseProblems}
        onRecheckRoster={recheckRoster}
        rechecking={rechecking}
        org={org}
        classroom={classroom}
        suppressedLogins={suppressedLogins}
        addActions={
          isOwner
            ? {
                onAddStudent: () => setAddOpen(true),
                onUploadRoster: () => setUploadOpen(true),
                onInviteLinks: () => setInviteOpen(true),
              }
            : undefined
        }
      />

      {isOwner ? (
        <>
          <AddStudent
            org={org}
            classroom={classroom}
            open={addOpen}
            onClose={() => setAddOpen(false)}
            // A re-enroll must clear any earlier session-unenroll suppression for
            // this login, else the auto-backfills would keep skipping the student
            // the teacher just re-added.
            onEnrolled={(username) => suppressedLogins.forget([username])}
          />
          <UploadRoster
            org={org}
            classroom={classroom}
            client={client}
            open={uploadOpen}
            onOpenChange={setUploadOpen}
            onSuccess={(result) => {
              // Show imported rows immediately (see useUpdateRosterCache).
              if (result.addedStudents.length > 0) {
                updateRosterCache((current) => [
                  ...current,
                  ...result.addedStudents.map(toStudent),
                ])
                // A re-uploaded student clears their earlier unenroll suppression.
                suppressedLogins.forget(
                  result.addedStudents.map((s) => s.username),
                )
              }
              invalidateInviteQueries(queryClient, org)
            }}
            onEmailSuccess={() => {
              // Email invites write no roster.csv row; they surface as `pending`
              // rows via the org pending-invitations list, so refresh those + the
              // team roster to show them at once.
              invalidateInviteQueries(queryClient, org)
              invalidateTeamRoster()
            }}
          />
          <InviteLinksModal
            org={org}
            classroom={classroom}
            open={inviteOpen}
            onClose={() => setInviteOpen(false)}
          />
        </>
      ) : null}
    </>
  )
}

// The CSV roster wrapper for a non-owner staffer — fires no team-membership or
// invite reads (so nothing 403s). See CsvRosterView for the roster.csv rationale.
const CsvRosterContent = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const { t } = useTranslation()
  const { students } = useGetStudents(org, classroom)

  return (
    <>
      <PageHeader
        title={t("nav.roster")}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <GitHubLink
              href={`https://github.com/${org}/${CONFIG_REPO}/blob/${DEFAULT_BRANCH}/${rosterPath(classroom)}`}
              label={t("students.viewCsvOnGitHub")}
              title={t("students.viewCsvOnGitHub")}
            />
          </span>
        }
      />
      <CsvRosterView students={students} />
    </>
  )
}

// Branch the roster experience on org ownership: a teacher (org owner) gets the
// team-driven roster with management; a TA/head TA gets the read-only CSV
// roster. Split so the owner-only useTeamRoster reads only run for an owner (a
// non-owner can't render TeamRosterContent without 403s).
const StudentListContent = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const { isOwner, isPending } = useIsOrgOwner()
  if (isPending) return <RoleResolvingFallback />
  return isOwner ? (
    <TeamRosterContent org={org} classroom={classroom} />
  ) : (
    <CsvRosterContent org={org} classroom={classroom} />
  )
}

const StudentListPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.roster"))
  const { org = "", classroom = "" } = useParams({ strict: false })

  return (
    <PageShell selected="roster">
      <Breadcrumb endpoint={t("nav.roster")} />
      <RequireRole>
        <StudentListContent org={org} classroom={classroom} />
      </RequireRole>
    </PageShell>
  )
}

export default StudentListPage
