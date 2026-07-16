import { BookText, UsersRound, Settings } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can } from "@/authz"
import { Tip, SidebarItemBody } from "./primitives"

export const StaffSidebarMenu = ({
  org,
  classroom,
  selected,
}: {
  org: string
  classroom: string
  selected: string
}) => {
  // Placeholder while pending so items never flash in then out.
  const { roleResolved, role: classroomRole } = useClassroomRoleContext()
  // Staff nav (Roster staff-only, Settings instructor-only) gates on the
  // preview-aware classroom role through the central can() policy, so "View as
  // student/TA" faithfully hides what a real student/TA wouldn't see. can()
  // already denies `unresolved`, so no separate resolved conjunct is needed.
  const showStaffItems = can("viewClassroomStaffContent", { classroomRole })
  const canEditSettings = can("editClassroomSettings", {
    classroomRole,
  })
  const { t } = useTranslation()

  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        <Tip label={t("nav.assignments")}>
          <Link to="/$org/$classroom/assignments" params={{ org, classroom }}>
            <SidebarItemBody
              label={t("nav.assignments")}
              icon={<BookText aria-hidden="true" />}
              active={selected === "assignments"}
            />
          </Link>
        </Tip>
        {!roleResolved ? (
          <>
            {[0, 1].map((i) => (
              <li key={i} className="flex px-2 py-2">
                <span className="skeleton h-4 w-24 bg-neutral-content/10" />
              </li>
            ))}
          </>
        ) : (
          showStaffItems && (
            <>
              <Tip label={t("nav.roster")}>
                <Link to="/$org/$classroom/roster" params={{ org, classroom }}>
                  <SidebarItemBody
                    label={t("nav.roster")}
                    icon={<UsersRound aria-hidden="true" />}
                    active={selected === "roster"}
                  />
                </Link>
              </Tip>
              {canEditSettings && (
                <Tip label={t("nav.settings")}>
                  <Link to="/$org/$classroom/edit" params={{ org, classroom }}>
                    <SidebarItemBody
                      label={t("nav.settings")}
                      icon={<Settings aria-hidden="true" />}
                      active={selected === "settings"}
                    />
                  </Link>
                </Tip>
              )}
            </>
          )
        )}
      </ul>
    </div>
  )
}
