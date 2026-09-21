import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"

import { useGithubAuth } from "@/auth/useGithubAuth"
import { ArrowLeftIcon, SignInIcon } from "@/components/ui/icons"
import { SidebarItemBody, SidebarNavItem } from "./primitives"

// The first row of a public page's rail: Back to app when signed in, Sign in
// when not. Public pages (/accessibility, /privacy) never mount the org/class
// menus, which need a GitHub client, so this is the visitor's way back.
export function PublicWayBackItem({ groupId }: { groupId: string }) {
  const { t } = useTranslation()
  const { status } = useGithubAuth()
  const signedIn = status === "authenticated"

  return signedIn ? (
    <SidebarNavItem label={t("nav.backToApp")}>
      <Link to="/">
        <SidebarItemBody
          label={t("nav.backToApp")}
          icon={<ArrowLeftIcon aria-hidden="true" />}
          active={false}
          groupId={groupId}
        />
      </Link>
    </SidebarNavItem>
  ) : (
    <SidebarNavItem label={t("nav.signIn")}>
      <Link to="/login">
        <SidebarItemBody
          label={t("nav.signIn")}
          icon={<SignInIcon aria-hidden="true" />}
          active={false}
          groupId={groupId}
        />
      </Link>
    </SidebarNavItem>
  )
}
