import { ChevronDown, ExternalLink, Info, RefreshCw } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { githubOAuthGrantUrl } from "@/auth/constants"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { Button } from "@/components/ui"
import useRefreshOnReturn from "@/hooks/useRefreshOnReturn"

// A missing org is almost never a membership problem: GitHub only reports orgs
// this OAuth app was granted, and the per-org "Grant" lives on the app's own
// authorization page, which teachers can't guess (discussions #352, #403).
// Rendered open when the org list is empty, collapsed otherwise.
function MissingOrgNotice({
  refreshing,
  onRefresh,
  defaultOpen = false,
}: {
  refreshing: boolean
  onRefresh: () => void
  defaultOpen?: boolean
}) {
  const { t } = useTranslation()
  const { startWebFlow } = useGithubAuth()
  const [open, setOpen] = useState(defaultOpen)
  const armRefreshOnReturn = useRefreshOnReturn(onRefresh)

  return (
    <details
      open={open}
      className="group rounded-xl border border-info/20 bg-info/5"
    >
      <summary
        // Controlled disclosure: driving <details> from its toggle event fights
        // React's `open` prop (closed sections need two clicks), so intercept
        // the summary click and own the state here — as LanguageSwitcher does.
        onClick={(e) => {
          e.preventDefault()
          setOpen((wasOpen) => !wasOpen)
        }}
        className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm"
      >
        <Info aria-hidden="true" className="size-4 shrink-0 text-info" />
        <span className="min-w-0 flex-1 truncate font-medium text-base-content">
          {t("orgs.missingNotice.title")}
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={refreshing}
          onClick={(e) => {
            // Inside <summary>: suppress the native toggle and keep the click
            // from reaching the handler above, so refreshing doesn't also
            // expand/collapse the disclosure.
            e.preventDefault()
            e.stopPropagation()
            onRefresh()
          }}
        >
          <RefreshCw
            aria-hidden="true"
            className={["size-3.5", refreshing ? "animate-spin" : ""].join(" ")}
          />
          {refreshing
            ? t("orgs.missingNotice.refreshing")
            : t("orgs.missingNotice.refresh")}
        </Button>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-base-content/50 transition-transform group-open:rotate-180"
        />
      </summary>

      <div className="border-t border-info/20 px-4 py-3">
        <p className="text-sm leading-6 text-base-content/70">
          {t("orgs.missingNotice.body")}
        </p>
        <ol className="mt-3 list-decimal space-y-1.5 ps-5 text-sm leading-6 text-base-content/70">
          <li>{t("orgs.missingNotice.steps.grant")}</li>
          <li>{t("orgs.missingNotice.steps.approve")}</li>
          <li>{t("orgs.missingNotice.steps.refresh")}</li>
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            as="a"
            href={githubOAuthGrantUrl()}
            target="_blank"
            rel="noreferrer"
            variant="primary"
            onClick={() => armRefreshOnReturn()}
          >
            {t("orgs.missingNotice.manageOauth")}
            <ExternalLink aria-hidden="true" className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void startWebFlow()}>
            {t("auth.reauthorize")}
          </Button>
        </div>
        <p className="mt-3 text-xs leading-5 text-base-content/60">
          {t("orgs.missingNotice.ssoHint")}
        </p>
        <p className="mt-1 text-xs leading-5 text-base-content/60">
          {t("orgs.missingNotice.pendingHint")}
        </p>
      </div>
    </details>
  )
}

export default MissingOrgNotice
