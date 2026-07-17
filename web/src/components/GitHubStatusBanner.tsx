import { useState } from "react"
import { CloudOff } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { AppBanner } from "@/components/AppBanner"
import { GitHubStatusNote } from "@/components/GitHubStatusNote"
import { useGitHubHealth } from "@/lib/githubHealth"

// Global warning banner shown when the app suspects GitHub is having trouble
// (repeated outage-shaped API failures), optionally enriched with the
// authoritative githubstatus.com summary. Heuristic, so it's dismissible
// (unlike OfflineBanner, which reflects a hard browser signal). Dismissal is
// scoped to the current suspicion episode: once a success clears suspicion the
// dismissed flag resets, so a later, distinct outage surfaces again.
export function GitHubStatusBanner() {
  const { suspected, statusDescription } = useGitHubHealth()
  const [dismissed, setDismissed] = useState(false)
  const { t } = useTranslation()

  // Reset the per-episode dismissal the moment suspicion clears, without an
  // effect (a render-time reset avoids the cascading-render lint).
  if (!suspected && dismissed) setDismissed(false)

  const show = suspected && !dismissed

  return (
    <AnimatePresence initial={false}>
      {show ? (
        <AppBanner
          key="github-status"
          tone="warning"
          icon={<CloudOff className="size-5" aria-hidden="true" />}
          title={t("githubStatus.title")}
          onDismiss={() => setDismissed(true)}
        >
          <GitHubStatusNote statusDescription={statusDescription} block />
        </AppBanner>
      ) : null}
    </AnimatePresence>
  )
}

export default GitHubStatusBanner
