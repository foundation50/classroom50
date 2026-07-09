import { WifiOff } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { AppBanner } from "@/components/AppBanner"
import { useOnlineStatus } from "@/hooks/useOnlineStatus"

// Global banner shown while the browser reports no network. Non-dismissible: it
// reflects live connectivity, so it clears itself the moment the `online` event
// fires (see useOnlineStatus) rather than needing a manual dismiss.
export function OfflineBanner() {
  const isOnline = useOnlineStatus()
  const { t } = useTranslation()

  return (
    <AnimatePresence initial={false}>
      {!isOnline ? (
        <AppBanner
          key="offline"
          tone="warning"
          icon={<WifiOff className="size-5" aria-hidden="true" />}
          title={t("offline.title")}
        >
          <p className="text-base-content/70">{t("offline.body")}</p>
        </AppBanner>
      ) : null}
    </AnimatePresence>
  )
}

export default OfflineBanner
