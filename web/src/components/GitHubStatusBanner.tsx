import { useState } from "react"
import { CloudOff } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { AppBanner } from "@/components/AppBanner"
import { useGitHubHealth } from "@/lib/githubHealth"

export const GITHUB_STATUS_URL = "https://www.githubstatus.com"

// The outage body text (confirmed vs generic) plus the githubstatus.com link —
// the single source of both, so the copy and URL can't drift between the authed
// banner and the unauthed stuck-bootstrap screen. `block` renders the banner's
// muted-paragraph + own-line link; the default is the inline fragment the
// unauthed screen wraps in its own <p>.
export function GitHubStatusNote({
  statusDescription,
  block = false,
}: {
  statusDescription: string | null
  block?: boolean
}) {
  const { t } = useTranslation()
  const body = statusDescription
    ? t("githubStatus.bodyConfirmed", { status: statusDescription })
    : t("githubStatus.bodyGeneric")
  const link = (
    <a
      href={GITHUB_STATUS_URL}
      target="_blank"
      rel="noreferrer"
      className={`link link-hover font-semibold text-base-content${
        block ? " self-start" : ""
      }`}
    >
      {t("githubStatus.checkStatusLink")}
    </a>
  )
  if (block) {
    return (
      <>
        <p className="text-base-content/70">{body}</p>
        {link}
      </>
    )
  }
  return (
    <>
      {body} {link}
    </>
  )
}

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
