import { useState } from "react"
import { ShieldAlert, TriangleAlert } from "lucide-react"
import { AnimatePresence } from "motion/react"
import { useTranslation } from "react-i18next"

import { useGithubAuth } from "./useGithubAuth"
import { AppBanner } from "@/components/AppBanner"
import {
  useMissingScopes,
  useTokenRevoked,
} from "@/context/github/GitHubProvider"

// Surfaces two distinct token problems detected from live API responses:
//   1. Revoked / expired token (401 Bad credentials) — the app can't make any
//      authenticated call; show an error and route to a fresh sign-in.
//   2. Missing required scopes — best-effort; offer re-authorize.
// Both are non-blocking. The revoked case takes precedence because a dead token
// makes the scope question moot.
export function ScopeWarningBanner() {
  const revoked = useTokenRevoked()
  const missing = useMissingScopes()
  const { startWebFlow, signOut } = useGithubAuth()
  const [dismissed, setDismissed] = useState(false)
  const { t } = useTranslation()

  if (revoked) {
    return (
      <AnimatePresence initial={false}>
        <AppBanner
          key="revoked"
          tone="error"
          icon={<TriangleAlert className="size-5" aria-hidden="true" />}
          title={t("auth.revokedTitle")}
        >
          <p className="text-base-content/70">
            {t("auth.revokedBody_prefix")}{" "}
            <code className="font-mono text-xs">401 Bad credentials</code>
            {t("auth.revokedBody_suffix")}
          </p>
          <button
            type="button"
            className="btn btn-sm btn-error self-start"
            onClick={() => signOut()}
          >
            {t("auth.signInAgain")}
          </button>
        </AppBanner>
      </AnimatePresence>
    )
  }

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
