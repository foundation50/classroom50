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
import { useParams } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import useGetStudents, { useUpdateRosterCache } from "@/hooks/useGetStudents"
import useGetClassroom from "@/hooks/useGetClassroom"
import useRosterStatus from "@/hooks/useRosterStatus"
import { invalidateInviteQueries } from "@/hooks/github/queries"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import RequireTeacher from "@/components/RequireTeacher"
import { countEnrolled, toStudent } from "@/util/roster"
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
  // Count from the same live partition the Enrolled section uses, so header and
  // badge agree. While status is loading/unavailable (non-owner), countEnrolled
  // falls back to the CSV "enrolled" signal rather than flashing 0.
  const rosterStatus = useRosterStatus(org, classroom, students)
  const enrolledCount = countEnrolled(rosterStatus, students)
  const className =
    classData?.name || classData?.short_name || t("students.untitledClass")

  return (
    <>
      <h1 className="text-lg pt-8 pb-2 font-bold">{t("nav.students")}</h1>
      <h3 className="pb-10">
        {t("students.enrolledIn", { count: enrolledCount, className })}
      </h3>
      <div className="grid grid-cols-12 gap-2">
        <div className="col-span-5 px-4">
          <AddStudent org={org} classroom={classroom} className="mb-8" />
          <UploadRoster
            org={org}
            classroom={classroom}
            client={client}
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
        </div>
        <div className="col-span-7 px-4">
          <EnrolledStudents
            students={students}
            org={org}
            classroom={classroom}
          />
        </div>
      </div>
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
