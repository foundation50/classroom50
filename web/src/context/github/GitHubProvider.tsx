import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react"
import {
  createGitHubClient,
  type GitHubClient,
  type GitHubResponseSignal,
} from "@/github-core/client"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { missingScopes, hasScope } from "@/auth/scopes"
import { ELEVATED_GITHUB_SCOPES } from "@/auth/constants"
import { GITHUB_PROXY_BASE } from "@/github-core/workerProxy"
import { observeResponse } from "@/lib/diagnostics/observed"
import { logger } from "@/lib/logger"

const log = logger.scope("context:github")

const GitHubClientContext = createContext<GitHubClient | null>(null)

// Latest per-response signal from a real API call, stamped with the token it
// belongs to. `scopes === null` means the X-OAuth-Scopes header was absent (e.g.
// a fine-grained PAT) — "unknown", not "no scopes". The stamp lets the reader
// ignore a value left over from a previous token without a reset effect.
type Observed = { token: string; signal: GitHubResponseSignal }
const ObservedContext = createContext<Observed | null>(null)

export function GitHubProvider({
  token,
  children,
}: PropsWithChildren<{ token: string | null }>) {
  const [observed, setObserved] = useState<Observed | null>(null)
  const { expireSession } = useGithubAuth()

  // Stamp each observation with the active token so a value carried over from a
  // previous token is ignored on read, not cleared via an effect (which tripped
  // the cascading-render lint).
  const onResponse = useCallback(
    (signal: GitHubResponseSignal) => {
      if (!token) return
      // Feed the diagnostics snapshot with the latest scopes/status regardless
      // of outcome (a 401 below still tears the session down after this).
      observeResponse(signal)
      // A live 401 means the token is revoked/expired: tear the session down so
      // the guard redirects to /login instead of stranding the user on a dead
      // authed page. expireSession() no-ops once the token is cleared.
      if (signal.status === 401) {
        log.warn("live 401 on API response, tearing down session", {
          record: true,
        })
        expireSession()
        return
      }
      // Keep the prior reference when the signal is unchanged so React bails out
      // — onResponse fires on every response and the steady state is an
      // unchanging 200 + scopes header.
      setObserved((prev) =>
        prev &&
        prev.token === token &&
        prev.signal.status === signal.status &&
        prev.signal.scopes === signal.scopes
          ? prev
          : { token, signal },
      )
    },
    [token, expireSession],
  )

  const client = useMemo(() => {
    if (!token) return null
    log.debug("creating GitHub client for new token")
    return createGitHubClient({
      token,
      archiveBaseUrl: GITHUB_PROXY_BASE,
      onResponse,
    })
  }, [token, onResponse])

  // Only surface the observation when it matches the live token.
  const current = observed && observed.token === token ? observed : null

  return (
    <GitHubClientContext.Provider value={client}>
      <ObservedContext.Provider value={current}>
        {children}
      </ObservedContext.Provider>
    </GitHubClientContext.Provider>
  )
}

export function useGitHubClient() {
  const client = useContext(GitHubClientContext)

  if (!client) {
    throw new Error("useGitHubClient must be used after GitHub auth is ready")
  }

  return client
}

export function useOptionalGitHubClient() {
  return useContext(GitHubClientContext)
}

// Required scopes the current token is missing, for the scope-warning banner.
// Prefers the live X-OAuth-Scopes observation; falls back to the login scope
// string. Fails open: with no value from either source, returns [] so the
// banner stays hidden rather than nagging about scopes we can't verify.
export function useMissingScopes(): string[] {
  const { tokenScope } = useGithubAuth()
  const observed = useContext(ObservedContext)

  // `||`, not `??`: a present-but-empty x-oauth-scopes header is "", which would
  // win over a usable login scope and suppress the warning entirely.
  const granted = observed?.signal.scopes || tokenScope

  return useMemo(() => {
    if (!granted) return []
    const missing = missingScopes(granted)
    if (missing.length > 0) {
      log.debug("token is missing required scopes", { missing })
    }
    return missing
  }, [granted])
}

// Whether the current token carries the elevated delete_repo scope (#655).
//
// Deliberately tri-state. The same fact needs opposite defaults in two places:
// gating a destructive action should fail open (GitHub is the real authority and
// teardown's 403 backstop aborts before anything irreversible), while *telling*
// the user their current state must never claim a permission we couldn't read.
// A single fail-open boolean served both and lied to the second caller.
//
// "unknown" covers a fine-grained PAT (no X-OAuth-Scopes header) and any session
// whose scopes we can't introspect.
export type DeleteRepoScopeState = "granted" | "missing" | "unknown"

export function useDeleteRepoScopeState(): DeleteRepoScopeState {
  const { tokenScope } = useGithubAuth()
  const observed = useContext(ObservedContext)

  // `||`, not `??`: a present-but-empty x-oauth-scopes header is "" (a classic
  // token with no scopes, or any header-rewriting hop), which would otherwise
  // beat a perfectly good login scope and read as unknown.
  const granted = observed?.signal.scopes || tokenScope

  return useMemo(() => {
    if (!granted) return "unknown"
    return ELEVATED_GITHUB_SCOPES.every((scope) => hasScope(granted, scope))
      ? "granted"
      : "missing"
  }, [granted])
}

// Gate for destructive actions: fails open on "unknown" so a session we can't
// introspect (a fine-grained PAT can delete via Administration: write) isn't
// blocked from an action GitHub may well permit.
export function useHasDeleteRepoScope(): boolean {
  return useDeleteRepoScopeState() !== "missing"
}
