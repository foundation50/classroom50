import { BookText } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Tip, SidebarItemBody } from "./primitives"

export const MyOrgs = ({ settings = false }) => {
  const { t } = useTranslation()
  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        <Tip label={t("nav.organizations")}>
          <Link to="/">
            <SidebarItemBody
              label={t("nav.organizations")}
              icon={<BookText aria-hidden="true" />}
              active={!settings}
            />
          </Link>
        </Tip>
      </ul>
    </div>
  )
}
