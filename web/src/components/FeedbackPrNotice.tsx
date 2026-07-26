import { AlertTriangle, Settings } from "lucide-react"
import { Trans, useTranslation } from "react-i18next"

import { Alert, cx, EmphasisLtr, RouterButton } from "@/components/ui"
import useFeedbackPrWarning from "@/hooks/useFeedbackPrWarning"
import type { FeedbackPrSubject } from "@/hooks/useFeedbackPrWarning"

// Warns a teacher that the Feedback PR won't open because org-wide autograding
// is paused (or Actions are off). A warning, not an error: nothing is broken and
// the pause is usually deliberate — it just has a consequence the assignment
// form never mentioned. Renders nothing when the hook is silent.
//
// `variant` exists because the two mount points differ structurally: the form
// mounts it beside a single toggle, where a page-width alert with a navigation
// button would visually outweigh the control it annotates.
export const FeedbackPrNotice = ({
  org,
  assignment,
  variant = "banner",
  className,
}: {
  org: string | undefined
  assignment: FeedbackPrSubject
  variant?: "banner" | "inline"
  className?: string
}) => {
  const { t } = useTranslation()
  const warning = useFeedbackPrWarning(org, assignment)

  if (!org || !warning.show) return null

  // Explicit map rather than a `…${reason}` template: a dynamically built key is
  // invisible to the i18n audit's static scan, which then reports both keys DEAD.
  const messageKey =
    warning.reason === "paused"
      ? "components.notices.feedbackPr.paused"
      : "components.notices.feedbackPr.disabled"

  const message = (
    <Trans
      i18nKey={messageKey}
      values={{ org }}
      components={{ org: <EmphasisLtr /> }}
    />
  )

  if (variant === "inline") {
    return (
      <Alert
        tone="warning"
        className={cx("flex items-start gap-2", className ?? "mt-2")}
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="text-sm">{message}</span>
      </Alert>
    )
  }

  return (
    <Alert
      tone="warning"
      className={cx(
        "flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between",
        className ?? "mb-6",
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="text-sm">{message}</span>
      </div>
      <RouterButton
        to="/$org/settings"
        params={{ org }}
        variant="warning"
        size="sm"
        className="whitespace-nowrap sm:shrink-0"
      >
        <Settings className="size-4" aria-hidden="true" />
        {t("components.notices.feedbackPr.action")}
      </RouterButton>
    </Alert>
  )
}

export default FeedbackPrNotice
