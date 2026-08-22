import { useParams } from "@tanstack/react-router"
import useGetClassroom from "@/hooks/useGetClassroom"
import { useOrgStaff } from "@/hooks/useOrgStaff"
import { useStudentClassrooms } from "@/hooks/useStudentClassrooms"
import { AllClasses, SidebarClassInfo } from "./primitives"
import { AssignmentSidebarMenu } from "./AssignmentSidebarMenu"
import { StaffSidebarMenu } from "./StaffSidebarMenu"
import { MyClasses } from "./MyClasses"
import { MyOrgs } from "./MyOrgs"

// Level bodies only (no logo/footer chrome — that stays mounted in
// DrawerSidebar, outside the AnimatePresence that swaps these). Each composer
// renders the menu for one nav level; DrawerSidebar cross-fades between them on
// a level change.

export const SidebarContent = ({ selected }: { selected: string }) => {
  const { org, classroom, assignment } = useParams({ strict: false })
  // Classroom identity from whichever source the role can read: classroom.json
  // lives in the private config repo (a guaranteed 404 for students — gate it
  // on staff), so a student's name/term come from their own team's bootstrap
  // record instead of falling back to the raw slug.
  const { isStaff } = useOrgStaff(org)
  const { data: classData } = useGetClassroom(org, classroom, {
    enabled: isStaff,
  })
  const { classrooms: studentClassrooms } = useStudentClassrooms(org)
  const studentRecord = studentClassrooms.find((c) => c.classroom === classroom)
  const classInfo =
    classData ??
    (studentRecord?.name
      ? { name: studentRecord.name, term: studentRecord.term }
      : undefined)

  // Inside a single assignment the nav is assignment-scoped: show assignment
  // actions (and a back link) instead of the classroom menu.
  if (org && classroom && assignment) {
    return (
      <AssignmentSidebarMenu
        org={org}
        classroom={classroom}
        assignment={assignment}
      />
    )
  }

  return (
    <>
      {org && <AllClasses org={org} />}
      <SidebarClassInfo classInfo={classInfo} />
      {org && classroom && (
        <StaffSidebarMenu selected={selected} org={org} classroom={classroom} />
      )}
    </>
  )
}

export const SidebarContentClasses = ({
  selected,
  settings = false,
}: {
  selected: string
  settings?: boolean
}) => {
  return <MyClasses selected={selected} settings={settings} />
}

export const SidebarContentOrgs = ({ selected }: { selected: string }) => {
  return <MyOrgs settings={selected === "settings"} />
}
