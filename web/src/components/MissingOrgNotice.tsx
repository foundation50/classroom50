import { ChevronDown, ExternalLink, Info, RefreshCw } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui"

// Collapsible notice explaining that GitHub only surfaces orgs the OAuth grant
// covers, with a link to manage that access and a refresh. Shared by the orgs
// page and the new-org modal so the "grant access" fix is always one click away
// when an org is missing.
function MissingOrgNotice({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  return (
    <details className="group rounded-xl border border-info/20 bg-info/5">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm">
        <Info aria-hidden="true" className="size-4 shrink-0 text-info" />
        <span className="min-w-0 flex-1 truncate font-medium text-base-content">
          {t("orgs.missingNotice.title")}
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={refreshing}
          onClick={(e) => {
            // The button lives inside <summary>; stop the click from toggling
            // the disclosure so refreshing doesn't also expand/collapse it.
            e.preventDefault()
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
        <Button
          as="a"
          href="https://github.com/settings/connections/applications"
          target="_blank"
          rel="noreferrer"
          variant="info"
          size="sm"
          className="mt-3"
        >
          {t("orgs.missingNotice.manageOauth")}
          <ExternalLink aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </details>
  )
}

export default MissingOrgNotice
