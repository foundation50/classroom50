import {
  ArrowLeftIcon,
  ChecklistIcon,
  DownloadIcon,
  FileIcon,
  PaintbrushIcon,
  SignInIcon,
} from "@primer/octicons-react"
import { Link, useRouterState } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import type { ReactNode } from "react"

import { useGithubAuth } from "@/auth/useGithubAuth"
import {
  ACCESSIBILITY_SECTIONS,
  sectionFromHash,
  type AccessibilitySection,
} from "@/util/a11y/accessibilitySections"
import { SidebarItemBody, SidebarNavItem } from "./primitives"

// Icons live in the view layer, not the shared (leaf) section source, so map
// section -> icon here. Keyed by id so a new section fails to type-check until
// it gets an icon.
const SECTION_ICON: Record<AccessibilitySection, ReactNode> = {
  conformance: <ChecklistIcon aria-hidden="true" />,
  "color-contrast": <PaintbrushIcon aria-hidden="true" />,
  statement: <FileIcon aria-hidden="true" />,
  downloads: <DownloadIcon aria-hidden="true" />,
}

// The sidebar BODY shown on the /accessibility page (public route), for both
// signed-in and signed-out visitors. An adaptive "way back" row (Back to app
// when authed, Sign in when not) plus the page's section deep links, so the
// real app drawer switches sections here without the org/class menus (which
// need a GitHub client) ever mounting. No "Accessibility" group title — the
// visitor is already on that page. Every row uses the shared nav primitives so
// it matches the app's other drawer items, including the sliding active pill.
export function AccessibilitySidebarNav() {
  const { t } = useTranslation()
  const { status } = useGithubAuth()
  const signedIn = status === "authenticated"
  const hash = useRouterState({ select: (s) => s.location.hash })
  const activeSection = sectionFromHash(hash)

  return (
    <div className="py-4">
      <ul className="flex flex-col gap-1">
        {signedIn ? (
          <SidebarNavItem label={t("nav.backToApp")}>
            <Link to="/">
              <SidebarItemBody
                label={t("nav.backToApp")}
                icon={<ArrowLeftIcon aria-hidden="true" />}
                active={false}
                groupId="accessibility"
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
                groupId="accessibility"
              />
            </Link>
          </SidebarNavItem>
        )}

        {ACCESSIBILITY_SECTIONS.map((s) => (
          <SidebarNavItem key={s.id} label={t(s.navLabelKey)}>
            <Link
              to="/accessibility"
              hash={s.id}
              // Match the hash too so the shared "/accessibility" pathname
              // doesn't mark every section active; the highlight is driven by
              // activeSection (the default no-hash state resolves to conformance).
              activeOptions={{ exact: true, includeHash: true }}
            >
              <SidebarItemBody
                label={t(s.navLabelKey)}
                icon={SECTION_ICON[s.id]}
                active={activeSection === s.id}
                groupId="accessibility"
              />
            </Link>
          </SidebarNavItem>
        ))}
      </ul>
    </div>
  )
}

export default AccessibilitySidebarNav
