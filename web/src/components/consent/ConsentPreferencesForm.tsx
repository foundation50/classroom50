import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"
import { useConsent } from "@/context/consent/ConsentProvider"
import {
  ALL_DENIED,
  DEFAULT_CHOICES,
  OPTIONAL_CONSENT_CATEGORIES,
  type ConsentChoices,
  type ConsentRecord,
} from "@/types/consent"

import { ConsentCategoryList } from "./ConsentCategoryList"

// The same choices as the consent prompt, for Settings and /privacy. When the
// browser sends Global Privacy Control / Do Not Track the form would be
// inert, so it says so instead. The draft is keyed on the saved record, so a
// decision or a Reset (record -> null) starts it afresh.
export function ConsentPreferencesForm({ idPrefix }: { idPrefix: string }) {
  const { t } = useTranslation()
  const { browserDeclines, record } = useConsent()
  if (browserDeclines) {
    return (
      <p className="text-sm text-base-content/70">
        {t("consent.browserDeclines")}
      </p>
    )
  }
  return (
    <Draft
      key={record?.at ?? "undecided"}
      idPrefix={idPrefix}
      record={record}
    />
  )
}

// One row per category, then start-aligned actions in the Settings form
// pattern (primary Save first). Starts from the saved record, or from the
// prompt's defaults for an undecided visitor, so the two surfaces always show
// the same state. Reset appears once a decision exists.
function Draft({
  idPrefix,
  record,
}: {
  idPrefix: string
  record: ConsentRecord | null
}) {
  const { t } = useTranslation()
  const { decide, reset } = useConsent()
  const [draft, setDraft] = useState<ConsentChoices>(() =>
    record ? choicesOf(record) : DEFAULT_CHOICES,
  )

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        decide(draft)
      }}
    >
      <ConsentCategoryList
        idPrefix={idPrefix}
        choices={draft}
        onChange={(category, granted) =>
          setDraft((current) => ({ ...current, [category]: granted }))
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm">
          {t("consent.savePreferences")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => decide(ALL_DENIED)}
        >
          {t("consent.declineAll")}
        </Button>
        {record && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ms-auto"
            onClick={reset}
          >
            {t("consent.reset")}
          </Button>
        )}
      </div>
    </form>
  )
}

// Only the categories: a record also carries `v` and `at`, which must not
// leak into a new decision.
function choicesOf(record: ConsentRecord): ConsentChoices {
  return Object.fromEntries(
    OPTIONAL_CONSENT_CATEGORIES.map((category) => [category, record[category]]),
  ) as ConsentChoices
}
