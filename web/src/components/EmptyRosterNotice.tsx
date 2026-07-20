import { Info, UserPlus } from "lucide-react"
import { Trans, useTranslation } from "react-i18next"

import { EmphasisLtr, RouterButton } from "@/components/ui"

// Empty/unenrolled-roster notice. Owns the daisyUI alert shell + ARIA so the
// assignments list and create pages can't drift in markup; copy adapts to
// whether the roster has rows (invited, not joined) or is empty. Rendered as an
// informational (info) tone — an empty roster is an expected state, not an
// error. Render only when useEmptyRosterWarning().show is true.
export const EmptyRosterNotice = ({
  org,
  classroom,
  hasRosterRows,
  className = "mb-6",
}: {
  org: string
  classroom: string
  hasRosterRows: boolean
  className?: string
}) => {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className={`alert alert-info alert-soft flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between ${className}`}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="text-sm">
          <Trans
            i18nKey={
              hasRosterRows
                ? "components.notices.emptyRoster.hasRows"
                : "components.notices.emptyRoster.empty"
            }
            values={{ org }}
            components={{ org: <EmphasisLtr /> }}
          />
        </span>
      </div>
      <RouterButton
        to="/$org/$classroom/roster"
        params={{ org, classroom }}
        variant="info"
        size="sm"
        className="whitespace-nowrap sm:shrink-0"
      >
        <UserPlus className="size-4" aria-hidden="true" />
        {hasRosterRows
          ? t("components.notices.emptyRoster.manageRoster")
          : t("components.notices.emptyRoster.addStudents")}
      </RouterButton>
    </div>
  )
}

export default EmptyRosterNotice
