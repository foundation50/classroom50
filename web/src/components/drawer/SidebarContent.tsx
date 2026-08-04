import { useParams } from "@tanstack/react-router"
import { AnimatePresence, motion } from "motion/react"
import type { ReactNode } from "react"
import useGetClassroom from "@/hooks/useGetClassroom"
import { sidebarLevelVariants } from "@/lib/motion"
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

// Swaps the menu region on a level change (orgs -> classes -> classroom ->
// assignment). `levelKey` drives AnimatePresence so the outgoing level slides
// out while the incoming one slides in; the shared chrome (logo, footer) around
// this stays put. mode="wait" avoids two menus overlapping mid-swap.
const LevelMenu = ({
  levelKey,
  children,
}: {
  levelKey: string
  children: ReactNode
}) => (
  <AnimatePresence mode="wait" initial={false}>
    <motion.div
      key={levelKey}
      variants={sidebarLevelVariants}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {children}
    </motion.div>
  </AnimatePresence>
)

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
        <LevelMenu levelKey={`assignment:${assignment}`}>
          <AssignmentSidebarMenu
            org={org}
            classroom={classroom}
            assignment={assignment}
          />
        </LevelMenu>
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
        <LevelMenu levelKey={`classroom:${classroom}`}>
          <StaffSidebarMenu
            selected={selected}
            org={org}
            classroom={classroom}
          />
        </LevelMenu>
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
      <LevelMenu levelKey="classes">
        <MyClasses selected={selected} settings={settings} />
      </LevelMenu>
      <SidebarFooter />
    </>
  )
}

export const SidebarContentOrgs = ({ selected }: { selected: string }) => {
  return (
    <>
      <ClassroomLogo />
      <ExpandSidebarButton />
      <LevelMenu levelKey="orgs">
        <MyOrgs settings={selected === "settings"} />
      </LevelMenu>
      <SidebarFooter />
    </>
  )
}
