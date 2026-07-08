import { useState } from "react"

import AddStudent from "@/pages/students/AddStudent"
import Breadcrumb from "@/components/breadcrumb"
import PageHeader from "@/components/PageHeader"
import PageShell from "@/components/PageShell"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import EnrolledStudents from "@/pages/students/EnrolledStudents"
import UploadRoster from "@/pages/students/UploadRoster"
import InviteLinksModal from "@/pages/students/InviteLinksModal"
import { GitHubLink } from "@/components/GitHubLink"
import { useParams } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import useGetStudents, { useUpdateRosterCache } from "@/hooks/useGetStudents"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import { invalidateInviteQueries } from "@/hooks/github/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import RequireTeacher from "@/components/RequireTeacher"
import { CONFIG_REPO } from "@/hooks/github/orgChecks"
import { toStudent } from "@/util/roster"
import { useTranslation } from "react-i18next"

const StudentListContent = ({
  org,
  classroom,
}: {
  org: string
  classroom: string
}) => {
  const { t } = useTranslation()
  const { students } = useGetStudents(org, classroom)
  const client = useGitHubClient()
  const queryClient = useQueryClient()
  const updateRosterCache = useUpdateRosterCache(org, classroom)

  // Which add-students affordance is open (all mutually exclusive modals).
  const [addOpen, setAddOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)

  // Count enrolled from the team roster (same source as EnrolledStudents), so
  // header and list agree. Enrollment is team membership, not the CSV.
  const {
    counts,
    isLoading: rosterLoading,
    isError: rosterError,
  } = useTeamRoster(org, classroom, students)
  const countReady = !rosterLoading && !rosterError
  const enrolledCount = counts.enrolled

  return (
    <>
      <PageHeader
        title={t("nav.students")}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {countReady
                ? t("students.enrolledCount", { count: enrolledCount })
                : t("students.enrolledCountLoading")}
            </span>
            <span aria-hidden="true" className="text-base-content/30">
              ·
            </span>
            <GitHubLink
              href={`https://github.com/${org}/${CONFIG_REPO}/blob/main/${classroom}/students.csv`}
              label={t("students.viewCsvOnGitHub")}
              title={t("students.viewCsvOnGitHub")}
            />
          </span>
        }
      />

      <EnrolledStudents
        students={students}
        org={org}
        classroom={classroom}
        addActions={{
          onAddStudent: () => setAddOpen(true),
          onUploadRoster: () => setUploadOpen(true),
          onInviteLinks: () => setInviteOpen(true),
        }}
      />

      <AddStudent
        org={org}
        classroom={classroom}
        open={addOpen}
        onClose={() => setAddOpen(false)}
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
          }
          invalidateInviteQueries(queryClient, org)
        }}
      />
      <InviteLinksModal
        org={org}
        classroom={classroom}
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
      />
    </>
  )
}

const StudentListPage = () => {
  const { t } = useTranslation()
  useDocumentTitle(t("documentTitle.students"))
  const { org = "", classroom = "" } = useParams({ strict: false })

  return (
    <PageShell selected="students">
      <Breadcrumb endpoint={t("nav.students")} />
      <RequireTeacher>
        <StudentListContent org={org} classroom={classroom} />
      </RequireTeacher>
    </PageShell>
  )
}

export default StudentListPage
