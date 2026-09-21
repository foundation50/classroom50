import { useId, useState } from "react"
import { useTranslation } from "react-i18next"

import { Collapse, Toggle, cx } from "@/components/ui"
import { ChevronRightIcon, LockIcon } from "@/components/ui/icons"
import type {
  ConsentCategory,
  ConsentChoices,
  OptionalConsentCategory,
} from "@/types/consent"

// What each category covers, as i18n keys under consent.categories.<id>.items.
// "necessary" has no toggle: it is what the app stores to work at all.
const CATEGORY_ITEMS: Record<ConsentCategory, readonly string[]> = {
  necessary: ["session", "preferences", "consent"],
  analytics: ["visits", "vendors", "cookie", "notCollected"],
}

const CATEGORIES: readonly ConsentCategory[] = ["necessary", "analytics"]

// One row per category: a toggle (locked on for "necessary"), a label, a
// one-line caption, and a "What this includes" disclosure. Shared by the
// consent dialog, Settings, and the public /privacy page so every surface
// explains the same things the same way.
export function ConsentCategoryList({
  choices,
  onChange,
  idPrefix,
}: {
  choices: ConsentChoices
  onChange: (category: OptionalConsentCategory, granted: boolean) => void
  idPrefix: string
}) {
  return (
    <ul className="flex flex-col gap-3">
      {CATEGORIES.map((category) => (
        <CategoryRow
          key={category}
          category={category}
          id={`${idPrefix}-${category}`}
          checked={category === "necessary" ? true : choices[category]}
          onChange={
            category === "necessary"
              ? undefined
              : (granted) => onChange(category, granted)
          }
        />
      ))}
    </ul>
  )
}

function CategoryRow({
  category,
  id,
  checked,
  onChange,
}: {
  category: ConsentCategory
  id: string
  checked: boolean
  onChange?: (granted: boolean) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const captionId = useId()
  const detailsId = useId()
  const locked = onChange === undefined

  return (
    <li className="rounded-field border border-base-300 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {locked ? (
            <span className="text-sm font-semibold">
              {t(`consent.categories.${category}.label`)}
            </span>
          ) : (
            <label htmlFor={id} className="text-sm font-semibold">
              {t(`consent.categories.${category}.label`)}
            </label>
          )}
          <p id={captionId} className="text-sm text-base-content/70">
            {t(`consent.categories.${category}.caption`)}
          </p>
        </div>
        {locked ? (
          <span
            className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-base-content/60"
            aria-describedby={captionId}
          >
            <LockIcon aria-hidden="true" className="size-3.5" />
            {t("consent.alwaysOn")}
          </span>
        ) : (
          <Toggle
            id={id}
            size="sm"
            className="mt-0.5 shrink-0"
            checked={checked}
            onChange={(event) => onChange(event.currentTarget.checked)}
            aria-describedby={captionId}
          />
        )}
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((open) => !open)}
        className="mt-2 flex items-center gap-1 text-xs font-medium text-info hover:underline"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cx(
            "size-3.5 transition-transform duration-200 rtl:-scale-x-100",
            expanded && "rotate-90 rtl:rotate-90",
          )}
        />
        {t("consent.whatThisIncludes")}
      </button>
      <Collapse open={expanded}>
        <ul
          id={detailsId}
          className="mt-2 list-disc space-y-1 ps-5 text-xs text-base-content/70"
        >
          {CATEGORY_ITEMS[category].map((item) => (
            <li key={item}>
              {t(`consent.categories.${category}.items.${item}`)}
            </li>
          ))}
        </ul>
      </Collapse>
    </li>
  )
}
