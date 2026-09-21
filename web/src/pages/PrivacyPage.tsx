import { useTranslation } from "react-i18next"

import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { DrawerShell } from "@/components/drawer"
import { ConsentPreferencesForm } from "@/components/consent/ConsentPreferencesForm"
import { useConsent } from "@/context/consent/ConsentProvider"
import { Card, ExternalLink, Heading } from "@/components/ui"
import { useDocumentTitle } from "@/hooks/useDocumentTitle"
import { DISCUSSIONS_URL, WIKI_URL } from "@/version"

const PRIVACY_WIKI_URL = `${WIKI_URL}/GitHub-Integration#privacy-and-ferpa`
const CLOUDFLARE_DPA_URL = "https://www.cloudflare.com/cloudflare-customer-dpa/"
const GOOGLE_DPT_URL = "https://business.safety.google/adsprocessorterms/"
// Google's Analytics terms require a prominent link to this page.
const GOOGLE_PARTNER_SITES_URL =
  "https://policies.google.com/technologies/partner-sites"

// Public /privacy page: the privacy notice plus the analytics opt-out, reachable
// before sign-in so a visitor can object without an account.
export default function PrivacyPage() {
  const { t } = useTranslation()
  const { browserDeclines } = useConsent()
  useDocumentTitle(t("privacy.pageTitle"))

  const collected = [
    t("privacy.analytics.collected.path"),
    t("privacy.analytics.collected.referrer"),
    t("privacy.analytics.collected.country"),
    t("privacy.analytics.collected.device"),
    t("privacy.analytics.collected.timings"),
    t("privacy.analytics.collected.cookie"),
  ]
  const notCollected = [
    t("privacy.analytics.notCollected.queryStrings"),
    t("privacy.analytics.notCollected.identity"),
    t("privacy.analytics.notCollected.ads"),
  ]

  return (
    <DrawerShell>
      <PageShell>
        <PageHeader
          title={t("privacy.pageTitle")}
          subtitle={t("privacy.pageSubtitle")}
        />

        <div className="flex max-w-2xl flex-col gap-6">
          <NoticeCard
            headingId="privacy-data"
            heading={t("privacy.data.heading")}
          >
            <p className="text-base-content/80">{t("privacy.data.body")}</p>
            <p className="text-base-content/80">
              {t("privacy.data.more")}{" "}
              <ExternalLink className="link-primary" href={PRIVACY_WIKI_URL}>
                {t("privacy.data.moreLink")}
              </ExternalLink>
              .
            </p>
          </NoticeCard>

          <NoticeCard
            headingId="privacy-analytics"
            heading={t("privacy.analytics.heading")}
          >
            <p className="text-base-content/80">
              {t("privacy.analytics.intro")}
            </p>
            <div className="grid gap-6 sm:grid-cols-2">
              <DisclosureList
                heading={t("privacy.analytics.collectedHeading")}
                items={collected}
              />
              <DisclosureList
                heading={t("privacy.analytics.notCollectedHeading")}
                items={notCollected}
              />
            </div>
            <p className="text-base-content/80">
              {t("privacy.analytics.processing")}
            </p>
            <ul className="list-disc space-y-1 ps-5 text-base-content/80">
              <li>
                <ExternalLink className="link-primary" href={GOOGLE_DPT_URL}>
                  {t("privacy.analytics.googleTerms")}
                </ExternalLink>
              </li>
              <li>
                <ExternalLink
                  className="link-primary"
                  href={GOOGLE_PARTNER_SITES_URL}
                >
                  {t("privacy.analytics.googleUsage")}
                </ExternalLink>
              </li>
              <li>
                <ExternalLink
                  className="link-primary"
                  href={CLOUDFLARE_DPA_URL}
                >
                  {t("privacy.analytics.cloudflareTerms")}
                </ExternalLink>
              </li>
            </ul>
            <p className="text-base-content/80">
              {t("privacy.analytics.retention")}
            </p>
          </NoticeCard>

          <NoticeCard
            headingId="privacy-choice"
            heading={t("privacy.choice.heading")}
          >
            <p className="text-base-content/80">{t("privacy.choice.body")}</p>
            {browserDeclines ? (
              <p className="text-sm text-base-content/70">
                {t("consent.browserDeclines")}
              </p>
            ) : (
              <ConsentPreferencesForm idPrefix="privacy-consent" />
            )}
            <p className="text-sm text-base-content/60">
              {t("privacy.choice.signals")}
            </p>
          </NoticeCard>

          <NoticeCard
            headingId="privacy-contact"
            heading={t("privacy.contact.heading")}
          >
            <p className="text-base-content/80">
              {t("privacy.contact.body")}{" "}
              <ExternalLink className="link-primary" href={DISCUSSIONS_URL}>
                {t("privacy.contact.link")}
              </ExternalLink>
              .
            </p>
          </NoticeCard>
        </div>
      </PageShell>
    </DrawerShell>
  )
}

function NoticeCard({
  headingId,
  heading,
  children,
}: {
  headingId: string
  heading: string
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={headingId}>
      <Card shadow={false}>
        <Card.Body className="gap-4 p-6">
          <Heading as="h2" variant="title-medium" id={headingId}>
            {heading}
          </Heading>
          {children}
        </Card.Body>
      </Card>
    </section>
  )
}

function DisclosureList({
  heading,
  items,
}: {
  heading: string
  items: string[]
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/60">
        {heading}
      </h3>
      <ul className="list-disc space-y-1 ps-5 text-base-content/80">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
