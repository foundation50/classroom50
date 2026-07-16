import { useParams } from "@tanstack/react-router"
import useGetClassroom from "@/hooks/useGetClassroom"
import {
  ClassroomLogo,
  ExpandSidebarButton,
  AllClasses,
  SidebarClassInfo,
} from "./primitives"
import { AssignmentSidebarMenu } from "./AssignmentSidebarMenu"
import { StaffSidebarMenu } from "./StaffSidebarMenu"
import { SidebarFooter } from "./SidebarFooter"
import { MyClasses } from "./MyClasses"
import { MyOrgs } from "./MyOrgs"

export const SidebarContent = ({ selected }: { selected: string }) => {
  const { org, classroom, assignment } = useParams({ strict: false })
  const { data: classData } = useGetClassroom(org, classroom)

  // Inside a single assignment the nav is assignment-scoped: show assignment
  // actions (and a back link) instead of the classroom menu.
  if (org && classroom && assignment) {
    return (
      <>
        <ClassroomLogo />
        <ExpandSidebarButton />
        <AssignmentSidebarMenu
          org={org}
          classroom={classroom}
          assignment={assignment}
        />
        <SidebarFooter />
      </>
    )
  }

  return (
    <>
      <ClassroomLogo />
      <ExpandSidebarButton />
      {org && <AllClasses org={org} />}
      <SidebarClassInfo classInfo={classData} />
      {org && classroom && (
        <StaffSidebarMenu selected={selected} org={org} classroom={classroom} />
      )}
      <SidebarFooter />
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
  return (
    <>
      <ClassroomLogo />
      <ExpandSidebarButton />
      <MyClasses selected={selected} settings={settings} />
      <SidebarFooter />
    </>
  )
}

export const SidebarContentOrgs = ({ selected }: { selected: string }) => {
  return (
    <>
      <ClassroomLogo />
      <ExpandSidebarButton />
      <MyOrgs settings={selected === "settings"} />
      <SidebarFooter />
    </>
  )
}
