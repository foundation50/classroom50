import { fetchGithubUserWithScopes } from "./github-user-api"
import { persistGithubToken } from "./storage"
import { missingScopes } from "./scopes"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_AUTH } from "@/lib/logScopes"

const log = logger.scope(LOG_SCOPE_AUTH)

// Decision for a validated PAT's X-OAuth-Scopes header, split out so every
// branch is unit-testable. A null header means the scopes are unverifiable —
// a fine-grained PAT — which we block at entry rather than sign in on a token
// we can't vet. An empty string is a classic token with no boxes ticked, which
// falls through to the missing-scopes check (missingScopes("") reports every
// required scope). "ok" carries the scope string forward to completeSignIn.
export type PatResult =
  | { kind: "fine-grained" }
  | { kind: "missing"; missing: string[] }
  | { kind: "ok"; scopes: string }

export function classifyPatResult(scopes: string | null): PatResult {
  if (scopes === null) return { kind: "fine-grained" }

  const missing = missingScopes(scopes)
  if (missing.length > 0) return { kind: "missing", missing }

  return { kind: "ok", scopes }
}

// Dev-only convenience: whether to auto-login from VITE_GITHUB_PAT on cold start.
// Gated on DEV and no stored token, so it never overrides a hand-signed-in
// session; the build-time token strip lives in vite.config.ts. Trimmed so a
// trailing newline in a `.env.local` value still works; blank/whitespace is a no-op.
export function resolveDevAutoLoginPat(input: {
  isDev: boolean
  hasStoredToken: boolean
  envPat: string | undefined
}): string | null {
  if (!input.isDev) return null
  if (input.hasStoredToken) return null
  const token = input.envPat?.trim()
  return token ? token : null
}

// Dev-only auto-login, hoisted to module scope so it runs exactly once per page
// load and survives StrictMode's mount→unmount→mount and Vite HMR remounts.
//
// A per-instance ref (or a bare module boolean) is not enough: the async PAT
// validation is kicked off from a mount effect, but StrictMode unmounts that
// instance before the fetch resolves, so the mutation's onSuccess lands on a
// discarded component and its completeSignIn is dropped — the token never
// reaches the surviving tree and the app hangs on the loading gate.
//
// The fix decouples the *credential* from the React lifecycle: this runs the
// validation once, and on success persists the token to localStorage right
// away. Whichever provider instance is mounted then reads it back via the
// normal "restored stored session" path (getStoredGithubToken), so a lost
// in-flight callback can't strand the app. The shared promise lets a live mount
// also complete sign-in immediately without waiting for the next render.
//
// Returns the validated { token, scope } on success, or null when auto-login
// does not apply / the token is rejected. Never runs in a prod build (gated on
// import.meta.env.DEV + an env PAT by the caller).
let devAutoLoginPromise: Promise<{
  token: string
  scope: string
} | null> | null = null

export function runDevAutoLoginOnce(
  envPat: string,
): Promise<{ token: string; scope: string } | null> {
  if (devAutoLoginPromise) return devAutoLoginPromise
  devAutoLoginPromise = (async () => {
    try {
      const { scopes } = await fetchGithubUserWithScopes(envPat)
      const result = classifyPatResult(scopes)
      if (result.kind !== "ok") {
        // A definitive rejection (fine-grained / missing scopes): keep it
        // cached — the same token won't pass on a retry this page load.
        log.warn("VITE_GITHUB_PAT auto-login rejected", { kind: result.kind })
        return null
      }
      // Persist immediately so a remount restores the session even if the mount
      // that started this validation was already torn down.
      persistGithubToken(envPat, result.scopes)
      log.info("dev auto-login validated; token persisted")
      return { token: envPat, scope: result.scopes }
    } catch (err) {
      // A transient failure (network blip / timeout / 5xx) is not the token's
      // fault. Clear the cached promise so the next mount re-attempts rather
      // than being stranded on the login screen for the rest of the page load.
      log.warn("VITE_GITHUB_PAT auto-login failed to validate", { err })
      devAutoLoginPromise = null
      return null
    }
  })()
  return devAutoLoginPromise
}

// Test-only: reset the once-per-page-load auto-login promise between renders, so
// each renderHook starts from a cold page-load state (the module promise
// otherwise persists across tests in the same file). Never called in app code.
export function __resetDevAutoLoginForTests() {
  devAutoLoginPromise = null
}
