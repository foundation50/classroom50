import { useTranslation } from "react-i18next"

import { Spinner } from "@/components/Spinner"
import { RateLimitWaitNotice } from "@/components/RateLimitWaitNotice"

// Shared pending state for the role-gated surfaces (RequireRole, the
// assignment index redirect, the SubmissionsPage self-guard). Labeled with
// what is actually resolving (Primer: name the load when known), and with the
// rate-limit countdown when that is what the wait is.
const RoleResolvingFallback = ({
  className = "min-h-[60vh]",
}: {
  className?: string
}) => {
  const { t } = useTranslation()
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div className="flex flex-col items-center gap-3">
        <Spinner size="lg" label={t("common.resolvingRole")} />
        <RateLimitWaitNotice />
      </div>
    </div>
  )
}

export default RoleResolvingFallback
