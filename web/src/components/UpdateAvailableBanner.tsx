import { useState } from "react"
import { RefreshCw } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { AppBanner } from "@/components/AppBanner"
import { Button } from "@/components/ui"
import { useVersionCheck } from "@/hooks/useVersionCheck"

// State the banner depends on — structural so the decision stays a pure,
// testable function (mirrors resolveDriftBannerView).
export type UpdateBannerInput = {
  hasUpdate: boolean
  // Deployed commit the user dismissed. Keyed by commit so a newer deploy
  // after dismissal re-prompts; session-only, so it also reappears on reload —
  // fine, since reloading is exactly what fetches the new build.
  dismissedCommit: string | undefined
  deployedCommit: string | undefined
}

export function resolveUpdateBannerVisible(input: UpdateBannerInput): boolean {
  const { hasUpdate, dismissedCommit, deployedCommit } = input
  if (!hasUpdate || !deployedCommit) return false
  return dismissedCommit !== deployedCommit
}

// Global prompt to reload when a newer build than the one this tab is running
// has been deployed (see useVersionCheck). Reload is loop-safe: the banner
// only shows when commits differ, and the reloaded build's commit matches. If
// a CDN edge still serves the old index.html after reload, the banner just
// re-shows dismissibly — fail-open.
export function UpdateAvailableBanner() {
  const { hasUpdate, data } = useVersionCheck()
  const [dismissedCommit, setDismissedCommit] = useState<string>()
  const { t } = useTranslation()

  const visible = resolveUpdateBannerVisible({
    hasUpdate,
    dismissedCommit,
    deployedCommit: data?.commit,
  })

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <AppBanner
          key="app-update"
          tone="success"
          icon={<RefreshCw className="size-5" aria-hidden="true" />}
          title={t("appUpdate.title")}
          onDismiss={() => setDismissedCommit(data?.commit)}
        >
          <p className="text-base-content/70">{t("appUpdate.body")}</p>
          <Button
            variant="success"
            size="sm"
            className="self-start"
            onClick={() => window.location.reload()}
          >
            {t("appUpdate.action")}
          </Button>
        </AppBanner>
      ) : null}
    </AnimatePresence>
  )
}

export default UpdateAvailableBanner
