import { BookText, Settings } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { SidebarItemBody, SidebarNavItem } from "./primitives"

export const MyOrgs = ({ settings = false }) => {
  const { t } = useTranslation()
  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        <SidebarNavItem label={t("nav.organizations")}>
          <Link to="/">
            <SidebarItemBody
              label={t("nav.organizations")}
              icon={<BookText aria-hidden="true" />}
              active={!settings}
              groupId="orgs"
            />
          </Link>
        </SidebarNavItem>
        <SidebarNavItem label={t("nav.settings")}>
          <Link to="/settings">
            <SidebarItemBody
              label={t("nav.settings")}
              icon={<Settings aria-hidden="true" />}
              active={settings}
              groupId="orgs"
            />
          </Link>
        </SidebarNavItem>
      </ul>
    </div>
  )
}
