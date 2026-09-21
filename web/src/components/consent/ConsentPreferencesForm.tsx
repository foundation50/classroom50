import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"
import { useConsent } from "@/context/consent/ConsentProvider"
import {
  ALL_DENIED,
  ALL_GRANTED,
  OPTIONAL_CONSENT_CATEGORIES,
  type ConsentChoices,
} from "@/types/consent"

import { ConsentCategoryList } from "./ConsentCategoryList"

// The decision form: category rows over three equal-footing actions. Edits a
// draft and commits on Save (Primer's explicit-save pattern); Accept all and
// Reject all commit at once. An undecided visitor starts from everything off,
// so nothing optional can be saved by accident.
export function ConsentPreferencesForm({
  idPrefix,
  onDecided,
}: {
  idPrefix: string
  onDecided?: () => void
}) {
  const { t } = useTranslation()
  const { record, decide } = useConsent()
  const [draft, setDraft] = useState<ConsentChoices>(() =>
    record ? pick(record) : ALL_DENIED,
  )

  const commit = (choices: ConsentChoices) => {
    setDraft(choices)
    decide(choices)
    onDecided?.()
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        commit(draft)
      }}
    >
      <ConsentCategoryList
        idPrefix={idPrefix}
        choices={draft}
        onChange={(category, granted) =>
          setDraft((current) => ({ ...current, [category]: granted }))
        }
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => commit(ALL_DENIED)}
        >
          {t("consent.rejectAll")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => commit(ALL_GRANTED)}
        >
          {t("consent.acceptAll")}
        </Button>
        <Button type="submit" variant="primary" size="sm">
          {t("consent.savePreferences")}
        </Button>
      </div>
    </form>
  )
}

function pick(record: ConsentChoices): ConsentChoices {
  return Object.fromEntries(
    OPTIONAL_CONSENT_CATEGORIES.map((category) => [category, record[category]]),
  ) as ConsentChoices
}
