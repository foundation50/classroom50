import { useId, useState } from "react"
import { useTranslation } from "react-i18next"

import { Checkbox, Collapse, HelpTooltip, Toggle, cx } from "@/components/ui"
import { ChevronRightIcon, LockIcon } from "@/components/ui/icons"
import type {
  ConsentCategory,
  ConsentChoices,
  OptionalConsentCategory,
} from "@/types/consent"

// What each category covers, as i18n keys under consent.categories.<id>.items.
// "functional" has no control: it is what the app stores to work at all.
const CATEGORY_ITEMS: Record<ConsentCategory, readonly string[]> = {
  functional: ["session", "preferences", "consent"],
  cloudflare: ["collected", "noCookies", "notCollected"],
  google: ["collected", "cookie", "notCollected", "ads"],
}

const CATEGORIES: readonly ConsentCategory[] = [
  "functional",
  "cloudflare",
  "google",
]

// The categories a visitor decides on, one control each, with the functional
// category shown as always on. Two shapes share the same copy: "full" is one
// bordered row per category with a toggle and a "What this includes"
// disclosure (Settings, /privacy); "compact" is a wrapping row of checkboxes
// with their captions, for the consent prompt.
export function ConsentCategoryList({
  choices,
  onChange,
  idPrefix,
  variant = "full",
}: {
  choices: ConsentChoices
  onChange: (category: OptionalConsentCategory, granted: boolean) => void
  idPrefix: string
  variant?: "full" | "compact"
}) {
  const Row = variant === "compact" ? CompactRow : FullRow
  return (
    <ul
      className={cx(
        variant === "compact"
          ? "flex flex-wrap gap-x-8 gap-y-3"
          : "flex flex-col gap-3",
      )}
    >
      {CATEGORIES.map((category) => (
        <Row
          key={category}
          category={category}
          id={`${idPrefix}-${category}`}
          checked={category === "functional" ? true : choices[category]}
          onChange={
            category === "functional"
              ? undefined
              : (granted) => onChange(category, granted)
          }
        />
      ))}
    </ul>
  )
}

type RowProps = {
  category: ConsentCategory
  id: string
  checked: boolean
  // Absent for the functional category, which has no control.
  onChange?: (granted: boolean) => void
}

function CompactRow({ category, id, checked, onChange }: RowProps) {
  const { t } = useTranslation()
  const captionId = useId()
  const locked = onChange === undefined
  return (
    <li className="flex items-start gap-2">
      {locked ? (
        <LockIcon
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 text-base-content/50"
        />
      ) : (
        <Checkbox
          id={id}
          size="sm"
          className="mt-0.5 shrink-0"
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
          aria-describedby={captionId}
        />
      )}
      <div className="flex min-w-0 flex-col">
        {locked ? (
          // No control to explain itself, so the "?" spells out exactly what
          // the app stores.
          <span className="flex items-center gap-1 text-sm font-medium">
            {t(`consent.categories.${category}.label`)}
            <span className="text-xs font-normal text-base-content/60">
              ({t("consent.alwaysOn")})
            </span>
            <HelpTooltip
              position="top"
              help={t(`consent.categories.${category}.tooltip`)}
            />
          </span>
        ) : (
          <label htmlFor={id} className="cursor-pointer text-sm font-medium">
            {t(`consent.categories.${category}.label`)}
          </label>
        )}
        <span id={captionId} className="text-xs text-base-content/60">
          {t(`consent.categories.${category}.caption`)}
        </span>
      </div>
    </li>
  )
}

function FullRow({ category, id, checked, onChange }: RowProps) {
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
