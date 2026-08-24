import {
  BookIcon,
  GearIcon,
  GlobeIcon,
  PeopleIcon,
  PulseIcon,
} from "@/components/ui/icons"
import { Link, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useOrgStaff } from "@/hooks/useOrgStaff"
import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { can } from "@/authz"
import { SidebarItemBody, SidebarNavItem } from "./primitives"

export const MyClasses = ({ settings = false, selected = "" }) => {
  const { org } = useParams({ strict: false })
  const { t } = useTranslation()
  const { isStaff, roleResolved } = useOrgStaff(org)
  // Members/Activity/Settings are owner-only surfaces, so their route access
  // stays gated on can("manageOrg") (RequireOwner). Their sidebar SHORTCUTS are
  // shown to a staff owner (`isStaff && isOwner`); since useOrgStaff now treats
  // an org owner as staff, a fresh owner on no staff team keeps the shortcuts
  // (and the routes). Team membership is the source of truth for non-owner
  // org-staff chrome.
  const { githubOrgRole } = useGitHubOrgRole()
  const isOwner = can("manageOrg", { githubOrgRole })
  const onSettings = settings || selected === "settings"
  const onPublished = selected === "published"
  const onMembers = selected === "members"
  const onActivity = selected === "activity"
  if (!org) return null

  // One label for staff and students: the /$org page lists CLASSROOMS for
  // both roles (students get their per-classroom summaries), so calling it
  // "My assignments" for students mislabeled the destination.
  const classesLabel = t("nav.myClasses")

  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        {!roleResolved ? (
          <li className="flex px-2 py-2">
            <span
              aria-hidden="true"
              className="skeleton skeleton-shimmer inline-block h-4 w-24 align-middle bg-neutral-content/10"
            />
          </li>
        ) : (
          <SidebarNavItem label={classesLabel}>
            <Link to="/$org" params={{ org }}>
              <SidebarItemBody
                label={classesLabel}
                icon={<BookIcon aria-hidden="true" />}
                active={
                  !onSettings && !onPublished && !onMembers && !onActivity
                }
                groupId="org"
              />
            </Link>
          </SidebarNavItem>
        )}
        {isStaff && (
          <SidebarNavItem label={t("nav.published")}>
            <Link to="/$org/published" params={{ org }}>
              <SidebarItemBody
                label={t("nav.published")}
                icon={<GlobeIcon aria-hidden="true" />}
                active={onPublished}
                groupId="org"
              />
            </Link>
          </SidebarNavItem>
        )}
        {isStaff && isOwner && (
          <SidebarNavItem label={t("nav.members")}>
            <Link to="/$org/members" params={{ org }}>
              <SidebarItemBody
                label={t("nav.members")}
                icon={<PeopleIcon aria-hidden="true" />}
                active={onMembers}
                groupId="org"
              />
            </Link>
          </SidebarNavItem>
        )}
        {isStaff && isOwner && (
          <SidebarNavItem label={t("nav.activity")}>
            <Link to="/$org/activity" params={{ org }}>
              <SidebarItemBody
                label={t("nav.activity")}
                icon={<PulseIcon aria-hidden="true" />}
                active={onActivity}
                groupId="org"
              />
            </Link>
          </SidebarNavItem>
        )}
        {isStaff && isOwner && (
          <SidebarNavItem label={t("nav.settings")}>
            <Link to="/$org/settings" params={{ org }}>
              <SidebarItemBody
                label={t("nav.settings")}
                icon={<GearIcon aria-hidden="true" />}
                active={onSettings}
                groupId="org"
              />
            </Link>
          </SidebarNavItem>
        )}
      </ul>
    </div>
  )
}
