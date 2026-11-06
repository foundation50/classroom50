import { useTranslation } from "react-i18next"

import { useRateLimitWait } from "@/hooks/useRateLimitWait"

// Explains a long guard spinner: GitHub is rate limiting this session and the
// gating read retries when the limit lifts. Renders nothing while no read is
// waiting on a rate limit, so the common fast path is unchanged.
export function RateLimitWaitNotice({ className }: { className?: string }) {
  const { t } = useTranslation()
  const seconds = useRateLimitWait()
  if (seconds === null) return null
  return (
    <p
      role="status"
      className={`text-sm text-base-content/70${className ? ` ${className}` : ""}`}
    >
      {seconds > 0
        ? t("common.rateLimitWait", { count: seconds })
        : t("common.rateLimitRetrying")}
    </p>
  )
}

export default RateLimitWaitNotice
