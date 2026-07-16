import { BookText, UsersRound, Settings, Globe, Activity } from "lucide-react"
import { Link, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useOrgStaff } from "@/hooks/useOrgStaff"
import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { can } from "@/authz"
import { Tip, SidebarItemBody } from "./primitives"

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

  const classesLabel = isStaff ? t("nav.myClasses") : t("nav.myAssignments")

  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        {!roleResolved ? (
          <li className="flex px-2 py-2">
            <span className="skeleton inline-block h-4 w-24 align-middle bg-neutral-content/10" />
          </li>
        ) : (
          <Tip label={classesLabel}>
            <Link to="/$org" params={{ org }}>
              <SidebarItemBody
                label={classesLabel}
                icon={<BookText aria-hidden="true" />}
                active={
                  !onSettings && !onPublished && !onMembers && !onActivity
                }
              />
            </Link>
          </Tip>
        )}
        {isStaff && (
          <Tip label={t("nav.published")}>
            <Link to="/$org/published" params={{ org }}>
              <SidebarItemBody
                label={t("nav.published")}
                icon={<Globe aria-hidden="true" />}
                active={onPublished}
              />
            </Link>
          </Tip>
        )}
        {isStaff && isOwner && (
          <Tip label={t("nav.members")}>
            <Link to="/$org/members" params={{ org }}>
              <SidebarItemBody
                label={t("nav.members")}
                icon={<UsersRound aria-hidden="true" />}
                active={onMembers}
              />
            </Link>
          </Tip>
        )}
        {isStaff && isOwner && (
          <Tip label={t("nav.activity")}>
            <Link to="/$org/activity" params={{ org }}>
              <SidebarItemBody
                label={t("nav.activity")}
                icon={<Activity aria-hidden="true" />}
                active={onActivity}
              />
            </Link>
          </Tip>
        )}
        {isStaff && isOwner && (
          <Tip label={t("nav.settings")}>
            <Link to="/$org/settings" params={{ org }}>
              <SidebarItemBody
                label={t("nav.settings")}
                icon={<Settings aria-hidden="true" />}
                active={onSettings}
              />
            </Link>
          </Tip>
        )}
      </ul>
    </div>
  )
}
