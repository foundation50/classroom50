import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"
import { useConsent } from "@/context/consent/ConsentProvider"
import {
  ALL_DENIED,
  DEFAULT_CHOICES,
  OPTIONAL_CONSENT_CATEGORIES,
  type ConsentChoices,
} from "@/types/consent"

import { ConsentCategoryList } from "./ConsentCategoryList"

// The same choices as the consent prompt, for Settings and /privacy: one row
// per category, then start-aligned actions in the Settings form pattern
// (primary Save first). Edits a draft and commits on Save. Starts from the
// saved record, or from the prompt's defaults for an undecided visitor, so the
// two surfaces always show the same state. Reset appears once a decision
// exists and makes the prompt ask again.
export function ConsentPreferencesForm({ idPrefix }: { idPrefix: string }) {
  const { t } = useTranslation()
  const { record, decide, declineAll, reset } = useConsent()
  const [draft, setDraft] = useState<ConsentChoices>(() =>
    record ? pick(record) : DEFAULT_CHOICES,
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
          onClick={() => {
            setDraft(ALL_DENIED)
            declineAll()
          }}
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

function pick(record: ConsentChoices): ConsentChoices {
  return Object.fromEntries(
    OPTIONAL_CONSENT_CATEGORIES.map((category) => [category, record[category]]),
  ) as ConsentChoices
}
