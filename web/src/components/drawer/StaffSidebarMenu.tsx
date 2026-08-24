import { BookIcon, GearIcon, PeopleIcon } from "@/components/ui/icons"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useClassroomRoleContext } from "@/context/classroomRole/ClassroomRoleProvider"
import { can } from "@/authz"
import { SidebarItemBody, SidebarNavItem } from "./primitives"

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
  // Staff nav (Roster staff-only, Settings teacher-only) gates on the
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
        {/* Roster leads for staff: it's the roster-first workflow surface
            (and matches the org-level menu's people-then-content order). A
            skeleton holds each staff slot while the role resolves so items
            never flash in then out. */}
        {!roleResolved ? (
          <li className="flex px-2 py-2">
            <span
              aria-hidden="true"
              className="skeleton skeleton-shimmer h-4 w-24 bg-neutral-content/10"
            />
          </li>
        ) : (
          showStaffItems && (
            <SidebarNavItem label={t("nav.roster")}>
              <Link to="/$org/$classroom/roster" params={{ org, classroom }}>
                <SidebarItemBody
                  label={t("nav.roster")}
                  icon={<PeopleIcon aria-hidden="true" />}
                  active={selected === "roster"}
                  groupId="staff"
                />
              </Link>
            </SidebarNavItem>
          )
        )}
        <SidebarNavItem label={t("nav.assignments")}>
          <Link to="/$org/$classroom/assignments" params={{ org, classroom }}>
            <SidebarItemBody
              label={t("nav.assignments")}
              icon={<BookIcon aria-hidden="true" />}
              active={selected === "assignments"}
              groupId="staff"
            />
          </Link>
        </SidebarNavItem>
        {!roleResolved ? (
          <li className="flex px-2 py-2">
            <span
              aria-hidden="true"
              className="skeleton skeleton-shimmer h-4 w-24 bg-neutral-content/10"
            />
          </li>
        ) : (
          showStaffItems &&
          canEditSettings && (
            <SidebarNavItem label={t("nav.settings")}>
              <Link to="/$org/$classroom/settings" params={{ org, classroom }}>
                <SidebarItemBody
                  label={t("nav.settings")}
                  icon={<GearIcon aria-hidden="true" />}
                  active={selected === "settings"}
                  groupId="staff"
                />
              </Link>
            </SidebarNavItem>
          )
        )}
      </ul>
    </div>
  )
}
