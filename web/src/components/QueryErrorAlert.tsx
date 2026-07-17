import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { Alert, Button } from "@/components/ui"

// Error banner (no dismiss) with an inline retry, shared by the submissions
// dashboard panels that load an independent data source (roster, gradebook).
// Extracted so the two blocks can't drift on markup/retry wiring.
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
    <Alert tone="error" className={className}>
      <div>
        {message}
        <Button variant="ghost" size="sm" className="ms-2" onClick={onRetry}>
          {t("submissions.errors.retry")}
        </Button>
      </div>
    </Alert>
  )
}
