import { useTranslation } from "react-i18next"

import { Card, Heading } from "@/components/ui"
import { ACCESSIBILITY_ISSUE_URL } from "@/version"

import { useVpatReport } from "./data"

// The public accessibility statement, following the plain-language shape W3C
// recommends: who it's for, how we measure up, known limitations, and how to
// give feedback. The "last reviewed" date reuses the VPAT report's generation
// date so it can't drift from the actual assessment.
export function StatementSection() {
  const { t } = useTranslation()
  const generated = useVpatReport().data?.generated ?? null

  return (
    <section aria-labelledby="statement-heading">
      <Card shadow={false}>
        <Card.Body className="max-w-2xl gap-6 p-6">
          <Heading as="h2" variant="title-medium" id="statement-heading">
            {t("accessibility.statement.heading")}
          </Heading>
          <p className="text-base-content/80">
            {t("accessibility.statement.intro")}
          </p>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/60">
              {t("accessibility.statement.targetHeading")}
            </h3>
            <p className="text-base-content/80">
              {t("accessibility.statement.target")}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/60">
              {t("accessibility.statement.limitationsHeading")}
            </h3>
            <p className="text-base-content/80">
              {t("accessibility.statement.limitations")}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-base-content/60">
              {t("accessibility.statement.feedbackHeading")}
            </h3>
            <p className="text-base-content/80">
              {t("accessibility.statement.feedback")}{" "}
              <a
                href={ACCESSIBILITY_ISSUE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="link link-primary"
              >
                {t("accessibility.statement.feedbackLink")}
              </a>
              .
            </p>
          </div>

          {generated && (
            <p className="text-xs text-base-content/50">
              {t("accessibility.statement.updated", { date: generated })}
            </p>
          )}
        </Card.Body>
      </Card>
    </section>
  )
}
