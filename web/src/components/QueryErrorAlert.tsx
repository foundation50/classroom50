import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

// A dismissable-free error banner with an inline retry, shared by the panels
// that load an independent data source (roster, gradebook) on the submissions
// dashboard. Extracted so the two blocks can't drift on markup/retry wiring.
export function QueryErrorAlert({
  message,
  onRetry,
  className = "mt-4",
}: {
  message: ReactNode
  onRetry: () => void
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <div className={`alert alert-error ${className}`}>
      <div>
        {message}
        <button
          type="button"
          className="btn btn-sm btn-ghost ml-2"
          onClick={onRetry}
        >
          {t("submissions.errors.retry")}
        </button>
      </div>
    </div>
  )
}
