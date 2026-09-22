import { useTranslation } from "react-i18next"

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { DrawerShell } from "@/components/drawer"
import { ConsentPreferencesForm } from "@/components/consent/ConsentPreferencesForm"
import { PrivacyNotice } from "@/components/consent/PrivacyNotice"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"

// Public /privacy page: the privacy notice plus the analytics choices, reachable
// before sign-in so a visitor can object without an account.
export default function PrivacyPage() {
  const { t } = useTranslation()
  useDocumentTitle(t("privacy.pageTitle"))

  return (
    <DrawerShell>
      <PageShell>
        <PageHeader
          title={t("privacy.pageTitle")}
          subtitle={t("privacy.pageSubtitle")}
        />
        <PrivacyNotice
          idPrefix="privacy"
          choice={<ConsentPreferencesForm idPrefix="privacy-consent" />}
        />
      </PageShell>
    </DrawerShell>
  )
}
