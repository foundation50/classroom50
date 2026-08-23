import { ChevronDown, ExternalLink, Info } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { githubOAuthGrantUrl } from "@/auth/constants"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { Button, HelpTooltip } from "@/components/ui"
import useRefreshOnReturn from "@/hooks/useRefreshOnReturn"

// GitHub only reports orgs this OAuth app was granted, and the per-org "Grant"
// lives on the app's own authorization page, which teachers can't guess
// (discussions #352, #403).
function MissingOrgNotice({
  onRefresh,
  defaultOpen = false,
}: {
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
      className="group rounded-box border border-info/20 bg-info/5"
    >
      <summary
        // React owns `open`; letting the native toggle through too would need
        // two clicks to reopen.
        onClick={(e) => {
          e.preventDefault()
          setOpen((wasOpen) => !wasOpen)
        }}
        className="flex cursor-pointer list-none items-center gap-2 rounded-box px-4 py-2.5 text-sm hover:bg-info/10"
      >
        <Info aria-hidden="true" className="size-4 shrink-0 text-info" />
        <span className="min-w-0 flex-1 truncate font-medium text-base-content">
          {t("orgs.missingNotice.title")}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-base-content/50 transition-transform group-open:rotate-180"
        />
      </summary>

      <div className="border-t border-info/20 px-4 py-3">
        <p className="text-sm leading-6 text-base-content/70">
          {t("orgs.missingNotice.body")}
        </p>
        <ol className="mt-2 list-decimal space-y-1 ps-5 text-sm leading-6 text-base-content/70">
          <li>
            {t("orgs.missingNotice.steps.grant")}
            <HelpTooltip help={t("orgs.missingNotice.steps.grantHelp")} />
          </li>
          <li>{t("orgs.missingNotice.steps.refresh")}</li>
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            as="a"
            href={githubOAuthGrantUrl()}
            target="_blank"
            rel="noreferrer"
            variant="primary"
            size="sm"
            onClick={armRefreshOnReturn}
          >
            {t("orgs.missingNotice.manageOauth")}
            <ExternalLink aria-hidden="true" className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void startWebFlow()}
          >
            {t("auth.reauthorize")}
          </Button>
          <HelpTooltip help={t("orgs.missingNotice.reauthorizeHelp")} />
        </div>
      </div>
    </details>
  )
}

export default MissingOrgNotice
