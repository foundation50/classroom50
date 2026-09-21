import { useTranslation } from "react-i18next"

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { DrawerShell } from "@/components/drawer"
import { ConsentPreferencesForm } from "@/components/consent/ConsentPreferencesForm"
import { PrivacyNotice } from "@/components/consent/PrivacyNotice"
import { useConsent } from "@/context/consent/ConsentProvider"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"

// Public /privacy page: the privacy notice plus the analytics choices, reachable
// before sign-in so a visitor can object without an account.
export default function PrivacyPage() {
  const { t } = useTranslation()
  const { browserDeclines, record } = useConsent()
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
          choice={
            browserDeclines ? (
              <p className="text-sm text-base-content/70">
                {t("consent.browserDeclines")}
              </p>
            ) : (
              <ConsentPreferencesForm
                key={record?.at ?? "undecided"}
                idPrefix="privacy-consent"
              />
            )
          }
        />
      </PageShell>
    </DrawerShell>
  )
}
