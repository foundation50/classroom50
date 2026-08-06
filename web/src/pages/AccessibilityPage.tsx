import type { ReactElement } from "react"
import { useTranslation } from "react-i18next"
import { useRouterState } from "@tanstack/react-router"

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { DrawerShell } from "@/components/drawer"
import {
  sectionFromHash,
  type AccessibilitySection,
} from "@/util/a11y/accessibilitySections"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"

import { VpatSection } from "./accessibility/VpatSection"
import { ContrastSection } from "./accessibility/ContrastSection"
import { StatementSection } from "./accessibility/StatementSection"
import { DownloadsSection } from "./accessibility/reports/PrintableReport"

// Public /accessibility page: renders the build-emitted vpat-report.json and
// contrast-audit.json (the sources of truth) across hash-routed sections. No
// auth, so an ADA/VPAT reviewer can open it. The heavy per-section rendering
// lives in ./accessibility/*; this file is only the shell + section routing.

export default function AccessibilityPage() {
  const { t } = useTranslation()
  useDocumentTitle(t("accessibility.pageTitle"))
  // The URL hash is the single source of truth for the active section, so the
  // public drawer's section links (and shared/bookmarked deep links) drive it.
  const hash = useRouterState({ select: (s) => s.location.hash })
  const section = sectionFromHash(hash)

  return (
    <DrawerShell>
      <PageShell>
        <PageHeader
          title={t("accessibility.pageTitle")}
          subtitle={t("accessibility.pageSubtitle")}
        />

        <SectionPanel section={section} />
      </PageShell>
    </DrawerShell>
  )
}

// Route the active section to its panel via a lookup so a new AccessibilitySection
// must register one here (the old ternary chain silently fell through to Downloads).
const SECTION_PANEL: Record<AccessibilitySection, () => ReactElement> = {
  conformance: VpatSection,
  "color-contrast": ContrastSection,
  statement: StatementSection,
  downloads: DownloadsSection,
}

function SectionPanel({ section }: { section: AccessibilitySection }) {
  const Panel = SECTION_PANEL[section]
  return <Panel />
}
