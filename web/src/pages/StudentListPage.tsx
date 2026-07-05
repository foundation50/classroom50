import { useState } from "react"
import { Plus, Send, Upload } from "lucide-react"

import AddStudent from "@/pages/students/AddStudent"
import Breadcrumb from "@/components/breadcrumb"
import Drawer, {
  DrawerContent,
  DrawerSidebar,
  DrawerToggle,
} from "@/components/drawer"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import EnrolledStudents from "@/pages/students/EnrolledStudents"
import UploadRoster from "@/pages/students/UploadRoster"
import InviteLinksModal from "@/pages/students/InviteLinksModal"
import { useParams } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import useGetStudents, { useUpdateRosterCache } from "@/hooks/useGetStudents"
import useGetClassroom from "@/hooks/useGetClassroom"
import { useTeamRoster } from "@/hooks/useTeamRoster"
import { invalidateInviteQueries } from "@/hooks/github/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import RequireTeacher from "@/components/RequireTeacher"
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
  const { data: classData } = useGetClassroom(org, classroom)
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
  const className =
    classData?.name || classData?.short_name || t("students.untitledClass")

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4 pt-8 pb-10">
        <div>
          <h1 className="text-lg font-bold">{t("nav.students")}</h1>
          <h3 className="text-base-content/70">
            {countReady
              ? t("students.enrolledIn", { count: enrolledCount, className })
              : t("students.enrolledInLoading", { className })}
          </h3>
        </div>

        {/* Consolidated "add students" widget: add one / upload roster /
            invite links. Icon-only to keep the roster the page's focus. */}
        <div className="join">
          <button
            type="button"
            className="btn btn-sm join-item"
            aria-label={t("students.addTitle")}
            title={t("students.addTitle")}
            onClick={() => setAddOpen(true)}
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            className="btn btn-sm join-item"
            aria-label={t("students.uploadRosterTitle")}
            title={t("students.uploadRosterTitle")}
            onClick={() => setUploadOpen(true)}
          >
            <Upload aria-hidden="true" className="size-4" />
          </button>
          <button
            type="button"
            className="btn btn-sm join-item"
            aria-label={t("students.inviteStudents")}
            title={t("students.inviteStudents")}
            onClick={() => setInviteOpen(true)}
          >
            <Send aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>

      <EnrolledStudents students={students} org={org} classroom={classroom} />

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
    <div className="min-h-screen">
      <Drawer>
        <DrawerToggle />
        <DrawerContent className="p-10 bg-base-200 2xl:px-50">
          <Breadcrumb endpoint={t("nav.students")} />
          <RequireTeacher>
            <StudentListContent org={org} classroom={classroom} />
          </RequireTeacher>
        </DrawerContent>
        <DrawerSidebar selected="students" />
      </Drawer>
    </div>
  )
}

export default StudentListPage
