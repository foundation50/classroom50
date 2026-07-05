import { useState } from "react"
import { ShieldAlert } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { useGithubAuth } from "./useGithubAuth"
import { AppBanner } from "@/components/AppBanner"
import { useMissingScopes } from "@/context/github/GitHubProvider"

// Surfaces missing required scopes detected from live API responses:
// best-effort, non-blocking, with a re-authorize action. A revoked/expired
// token is handled separately — a live 401 tears the session down and redirects
// to /login (see GitHubProvider.onResponse and useGithubAuth.expireSession).
export function ScopeWarningBanner() {
  const missing = useMissingScopes()
  const { startWebFlow } = useGithubAuth()
  const [dismissed, setDismissed] = useState(false)
  const { t } = useTranslation()

  const show = missing.length > 0 && !dismissed
  const scopeCount = missing.length

  return (
    <AnimatePresence initial={false}>
      {show ? (
        <AppBanner
          key="missing-scopes"
          tone="warning"
          icon={<ShieldAlert className="size-5" aria-hidden="true" />}
          title={t("auth.missingScopesTitle")}
          onDismiss={() => setDismissed(true)}
        >
          <p className="text-base-content/70">
            {t("auth.missingScopesBody", { count: scopeCount })}{" "}
            <code className="font-mono text-xs">{missing.join(", ")}</code>
            {t("auth.missingScopesBody_suffix", { count: scopeCount })}
          </p>
          <button
            type="button"
            className="btn btn-sm btn-warning self-start"
            onClick={() => void startWebFlow()}
          >
            {t("auth.reauthorize")}
          </button>
          <p className="text-xs text-base-content/70">
            {t("auth.reauthorizeHint")}
          </p>
        </AppBanner>
      ) : null}
    </AnimatePresence>
  )
}
