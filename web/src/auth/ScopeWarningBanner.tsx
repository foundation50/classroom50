import { useState } from "react"
import { ShieldAlert } from "lucide-react"
import { AnimatePresence } from "motion/react"

import { useGithubAuth } from "./useGithubAuth"
import { AppBanner } from "@/components/AppBanner"
import { useMissingScopes } from "@/context/github/GitHubProvider"

// Surfaces missing required scopes detected from live API responses:
// best-effort, non-blocking; offers a re-authorize action. A revoked/expired
// token is handled separately — a live 401 tears the session down and redirects
// to /login (see GitHubProvider.onResponse and useGithubAuth.expireSession).
export function ScopeWarningBanner() {
  const missing = useMissingScopes()
  const { startWebFlow } = useGithubAuth()
  const [dismissed, setDismissed] = useState(false)

  const show = missing.length > 0 && !dismissed

  return (
    <AnimatePresence initial={false}>
      {show ? (
        <AppBanner
          key="missing-scopes"
          tone="warning"
          icon={<ShieldAlert className="size-5" aria-hidden="true" />}
          title="Some GitHub permissions are missing"
          onDismiss={() => setDismissed(true)}
        >
          <p className="text-base-content/70">
            This app needs the {missing.length === 1 ? "scope" : "scopes"}{" "}
            <code className="font-mono text-xs">{missing.join(", ")}</code>.
            Some actions may fail until{" "}
            {missing.length === 1 ? "it is" : "they are"} granted.
          </p>
          <button
            type="button"
            className="btn btn-sm btn-warning self-start"
            onClick={() => void startWebFlow()}
          >
            Re-authorize
          </button>
          <p className="text-xs text-base-content/70">
            If re-authorizing doesn&apos;t clear this, an organization owner may
            need to approve the app in the org&apos;s OAuth policy settings.
          </p>
        </AppBanner>
      ) : null}
    </AnimatePresence>
  )
}
