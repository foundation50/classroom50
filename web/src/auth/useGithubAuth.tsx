import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react"
import { useTranslation } from "react-i18next"
import {
  DEFAULT_GITHUB_SCOPE,
  ELEVATED_GITHUB_SCOPE,
  GITHUB_OAUTH_CLIENT_ID,
} from "./constants"
import {
  buildGithubAuthorizeUrl,
  exchangeWebCode,
  pollDeviceToken,
  requestDeviceCode,
} from "./github-oauth-api"
import {
  fetchGithubUser,
  fetchGithubUserWithScopes,
  GitHubUserFetchError,
} from "./github-user-api"
import { isDefinitiveGitHubStatus } from "@/github-core/errors"
import router from "@/router"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_AUTH } from "@/lib/logScopes"
import { deriveChallenge, generateVerifier, randomBase64Url } from "./pkce"
import {
  classifyPatResult,
  resolveDevAutoLoginPat,
  runDevAutoLoginOnce,
} from "./devAutoLogin"

// Re-exported so the auth module's public surface (and existing test imports)
// stay stable after the dev auto-login machinery moved to ./devAutoLogin.
export {
  classifyPatResult,
  resolveDevAutoLoginPat,
  runDevAutoLoginOnce,
  __resetDevAutoLoginForTests,
  type PatResult,
} from "./devAutoLogin"
import { useOnlineStatus } from "@/hooks/useOnlineStatus"
import {
  clearGithubToken,
  consumeOAuthSession,
  getStoredGithubClientId,
  getStoredAuthMethod,
  getStoredGithubScope,
  getStoredGithubToken,
  persistGithubClientId,
  persistGithubToken,
  saveOAuthSession,
} from "./storage"
import type {
  AuthMethod,
  DeviceAuthState,
  GithubAuthScreen,
  PatTokenType,
  SignInOptions,
  WebSignInOptions,
} from "./types"
import type { AuthStatus } from "@/types/router"

// Translator shape used for the auth error strings. Matches the subset of
// react-i18next's `t` we rely on (key + optional interpolation values).
type Translate = (key: string, options?: Record<string, unknown>) => string

const log = logger.scope(LOG_SCOPE_AUTH)

function formatError(
  t: Translate,
  err: unknown,
  // The subsystem a network failure most likely implicates. The web/device
  // flows go through the Worker OAuth proxy; the PAT flow hits api.github.com
  // directly, so it passes its own label instead of blaming a proxy it never
  // touches. Defaults to the proxy target for the OAuth/device callers.
  networkTarget: string = t("auth.errorNetworkProxyTarget"),
) {
  const message = err instanceof Error ? err.message : String(err)

  log.debug("formatting auth error for display", { message })

  if (
    message.toLowerCase().includes("failed to fetch") ||
    message.toLowerCase().includes("networkerror")
  ) {
    // A fetch failure while the browser reports no network is the client being
    // offline, not our proxy/GitHub being down — don't misattribute blame.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return t("auth.errorOffline")
    }
    return t("auth.errorNetwork", { target: networkTarget })
  }

  // A server-provided message (e.g., an OAuth error_description) is already a
  // formed string we can't pre-translate; pass it through unchanged.
  return message
}

// Cold-reload teardown gate: a stored token is only torn down when /user
// validation returns a definitive 401 (revoked/expired). A 403 is usually
// rate-limiting and a 5xx/network blip is transient — expiring on either would
// wipe a valid token (GitHubUserFetchError carries no headers to tell them
// apart), so both are preserved.
export function shouldExpireOnUserError(error: unknown): boolean {
  return error instanceof GitHubUserFetchError && error.status === 401
}

// A /user validation error that should self-heal on refetch/reconnect: a network
// failure (no status — a TypeError from fetch, incl. a captive portal) or a
// non-definitive GitHub status (5xx / 429). A definitive GitHub status
// (401/403/404 per isDefinitiveGitHubStatus) is NOT transient — retrying can't
// change it — so it must not hold at "loading" forever. `undefined`/`null` (no
// error) is not transient.
export function isTransientUserError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof GitHubUserFetchError) {
    return !isDefinitiveGitHubStatus(error.status)
  }
  // A non-GitHubUserFetchError reaching here is a fetch/network failure.
  return true
}

// State the auth status verdict depends on — structural so the decision stays a
// pure, testable function (mirrors the repo's resolve* pattern).
export type AuthStatusInput = {
  hasLoadedStoredAuth: boolean
  hasToken: boolean
  isOnline: boolean
  userQueryPending: boolean
  userQueryErrored: boolean
  // The /user validation failed with a definitive 401 — the token is genuinely
  // revoked/expired (shouldExpireOnUserError). Distinct from `userQueryErrored`,
  // which is true for any failure including recoverable ones.
  userErrorExpiresToken: boolean
  // The error is transient (5xx / network / captive-portal / 429) rather than a
  // definitive GitHub status — it should self-heal on refetch/reconnect, so we
  // hold. A definitive non-401 (403 SSO/blocked, 404) is NOT transient: it won't
  // clear on its own, so holding would strand the user on a spinner forever.
  userErrorIsTransient: boolean
  hasUser: boolean
  // A dev VITE_GITHUB_PAT auto-login is validating; its token lands async, so
  // hold at "loading" rather than "unauthenticated" (see resolveAuthStatus).
  autoLoginPending: boolean
}

// Whether a token holder is stranded on the loading hold with no way forward:
// online, no cached user, and the /user validation has SETTLED into a transient
// error (retries exhausted, not still fetching). resolveAuthStatus keeps this
// case at "loading" on purpose (#187 — don't eject a valid session on a blip),
// but a *persistent* transient failure (a proxy/extension blocking
// api.github.com, or a wedged stored session) would otherwise spin forever with
// no escape. This drives the retry / sign-in-again affordance on the hold
// screen. A 401 (dead token) and a definitive non-401 don't reach here — the
// first signs out, the second resolves to "authenticated".
export function isValidationStuck(input: {
  hasToken: boolean
  isOnline: boolean
  hasUser: boolean
  userQueryErrored: boolean
  userErrorIsTransient: boolean
  userQueryFetching: boolean
}): boolean {
  return (
    input.hasToken &&
    input.isOnline &&
    !input.hasUser &&
    input.userQueryErrored &&
    input.userErrorIsTransient &&
    !input.userQueryFetching
  )
}

// Resolve the auth status for the router guard.
//
// Two offline cases, deliberately split:
//   - Already validated this session (hasUser): stay "authenticated" even when
//     offline. The app stays mounted on cached data and the OfflineBanner (in
//     the _authed layout) explains the state — don't collapse a working session
//     to a full-screen spinner on a network blip.
//   - Not yet validated + offline (cold reload, no cached user): hold at
//     "loading". The GET /user validation can't run offline, so an
//     error/absent-user must NOT report "unauthenticated" and bounce a
//     still-valid session to /login. We hold until connectivity returns.
//
// First-validation error triage (token present, no cached user yet):
//   - Definitive 401 (userErrorExpiresToken): the token is dead — sign out.
//   - Transient (5xx / network / captive-portal / 429): recoverable — hold at
//     "loading" and let the refetch self-heal, rather than bouncing a still-
//     valid session to /login (#185's regression).
//   - Definitive non-401 (403 SSO/blocked, 404): the token is valid but this
//     won't clear on its own; resolve to "authenticated" so the app mounts and
//     its per-resource gates (scope/SSO banners) handle it — holding would
//     strand the user on a spinner forever.
//
// The matching 401 teardown elsewhere clears `hasToken` + the cached user, so
// no branch can mask a truly dead token.
export function resolveAuthStatus(input: AuthStatusInput): AuthStatus {
  if (!input.hasLoadedStoredAuth) return "loading"
  // A dev auto-login's token lands async: hold "loading" in the startup gap so
  // the guard doesn't bounce a deep link to /login. Never set in a prod build.
  if (input.autoLoginPending && !input.hasToken) return "loading"
  if (!input.hasToken) return "unauthenticated"
  if (input.hasUser) return "authenticated"
  if (input.userErrorExpiresToken) return "unauthenticated"
  if (!input.isOnline) return "loading"
  if (input.userQueryPending) return "loading"
  if (input.userQueryErrored && input.userErrorIsTransient) return "loading"
  return "authenticated"
}

// Recover a stranded "exchanging" screen: with no ?code to exchange (fresh
// reload or a bfcache Back from GitHub's consent screen), the card would spin
// forever, so reset it to "config". Every other screen is left as-is.
export function recoverStrandedExchange(
  current: GithubAuthScreen,
): GithubAuthScreen {
  return current === "exchanging" ? "config" : current
}

// The screen a device flow returns to once it stops: the one the session is
// actually in. Hardcoding "config" would park an authenticated session on the
// login surface.
export function idleScreen(token: string | null): GithubAuthScreen {
  return token ? "authed" : "config"
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    // One AbortController spans a whole device flow (~180 sleeps), so a listener
    // that only self-removes on abort would pile up for the flow's lifetime.
    const onAbort = () => {
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    signal.addEventListener("abort", onAbort, { once: true })
  })
}

// Holds all auth state. Instantiate only once, in GitHubAuthProvider; other
// consumers use the useGithubAuth() context hook below.
function useGithubAuthState() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const isOnline = useOnlineStatus()
  const abortRef = useRef<AbortController | null>(null)
  // Bumped whenever a device flow is cancelled or fails. `startDeviceFlow`
  // captures the current value and its callbacks no-op if it changed, because
  // the device-code request itself is not abortable: abortRef only exists once
  // polling starts, so without this a cancel during the in-flight request lets a
  // poll start (and swap the session token) with no UI attached.
  const deviceGenRef = useRef(0)
  // Deep link (#71) stashed at code-exchange, consumed by the status-driven
  // effect below so navigation runs against an authenticated router context.
  const pendingReturnToRef = useRef<string | null>(null)

  const [screen, setScreen] = useState<GithubAuthScreen>("config")
  const [clientId, setClientId] = useState(GITHUB_OAUTH_CLIENT_ID)
  const [token, setToken] = useState<string | null>(null)
  // Mirror of `token` for callbacks that only read it when invoked. Depending on
  // `token` instead would churn their identity on every sign-in, and a consumer
  // keying a cleanup effect off one would stop being unmount-only.
  const tokenRef = useRef(token)
  const [tokenScope, setTokenScope] = useState("")
  // How the live session signed in; null until restored/known. Only an OAuth
  // session can be re-issued in-app, so this gates whether a missing
  // destructive scope offers a re-auth or a replace-your-token warning (#655).
  const [authMethod, setAuthMethod] = useState<AuthMethod | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Scoped to the PAT prompt so a token-entry failure surfaces on that screen
  // without disturbing the config screen's `error`.
  const [patError, setPatError] = useState<string | null>(null)
  // Which PAT variant the user chose from "other sign-in methods"; drives the
  // prompt's guidance + pre-fill (classic vs fine-grained).
  const [patTokenType, setPatTokenType] = useState<PatTokenType>("classic")
  const [device, setDevice] = useState<DeviceAuthState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [hasLoadedStoredAuth, setHasLoadedStoredAuth] = useState(false)
  // Holds status at "loading" while a dev auto-login validates (see
  // resolveAuthStatus). Dev-only; stays false in prod builds.
  const [autoLoginPending, setAutoLoginPending] = useState(false)
  // Set when a live API 401 (revoked/expired token) tears the session down, so
  // /login can explain why the user was signed out. A deliberate signOut()
  // clears it.
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    tokenRef.current = token
  }, [token])

  const githubUserQuery = useQuery({
    queryKey: ["github", "user", token],
    queryFn: () => fetchGithubUser(token!),
    enabled: Boolean(token),
    staleTime: 60 * 60 * 1000,
    // A definitive status (401 revoked, 403 SSO/blocked, 404) resolves
    // immediately — retrying can't change it. Transient failures (5xx/network)
    // self-heal with a bounded retry so a momentary blip doesn't eject a
    // signed-in user. Shares the policy with the GitHub-client reads (see
    // retryTransientGitHubError / isDefinitiveGitHubStatus).
    retry: (failureCount, error) => {
      if (
        error instanceof GitHubUserFetchError &&
        isDefinitiveGitHubStatus(error.status)
      ) {
        return false
      }
      return failureCount < 2
    },
  })

  // Auth-flow mutations — a deliberate exception to the hooks/mutations/
  // boundary (see that README). These drive the login state machine (screen /
  // device / error), not GitHub data writes against the app's query cache:
  // there is nothing to invalidate or reconcile, each has a single call site
  // inside this provider, and their .isPending feeds this hook's returned flags
  // (isRequestingDeviceCode / isValidatingPat). Lifting them into standalone
  // hooks would fragment the state machine for no data-consistency gain.
  const exchangeCodeMutation = useMutation({
    mutationFn: exchangeWebCode,
  })

  const requestDeviceCodeMutation = useMutation({
    mutationFn: requestDeviceCode,
  })

  const validatePatMutation = useMutation({
    mutationFn: fetchGithubUserWithScopes,
  })

  // Shared landing for both web and device flows. Goes straight to the authed
  // screen and prefetches the profile; once it resolves, status flips to
  // authenticated and the /login guard redirects into the app. Until then the
  // card shows a spinner (no interstitial success splash).
  const completeSignIn = useCallback(
    (data: {
      access_token: string
      scope?: string
      authMethod: AuthMethod
    }) => {
      log.info("sign-in complete, token acquired")
      persistGithubToken(data.access_token, data.scope || "", data.authMethod)
      setToken(data.access_token)
      setTokenScope(data.scope || "")
      setAuthMethod(data.authMethod)
      setSessionExpired(false)
      setDevice(null)
      setScreen("authed")

      queryClient.prefetchQuery({
        queryKey: ["github", "user", data.access_token],
        queryFn: () => fetchGithubUser(data.access_token),
      })
    },
    [queryClient],
  )

  // Validate a token against GET /user + its X-OAuth-Scopes, then sign in or
  // report why it was rejected. Shared by the manual PAT prompt (submitPat) and
  // the dev auto-login so both apply identical scope rules. `onReject` gets an
  // already-translated message; `onSettled` (optional) fires once either way, so
  // the auto-login can release its loading hold.
  const validateAndSignInWithPat = useCallback(
    (
      token: string,
      onReject: (message: string) => void,
      onSettled?: () => void,
    ) => {
      log.info("validating personal access token")
      validatePatMutation.mutate(token, {
        onSuccess: ({ scopes }) => {
          const result = classifyPatResult(scopes)

          // A fine-grained PAT (null header) exposes no scopes to verify here;
          // accept it and let the runtime backstop (GitHubProvider 401 teardown)
          // govern its per-resource permissions. It carries an empty granted
          // scope so useMissingScopes stays fail-open (no spurious banner).
          if (result.kind === "fine-grained-ok") {
            completeSignIn({
              access_token: token,
              scope: "",
              authMethod: "pat",
            })
            return
          }

          if (result.kind === "missing") {
            log.warn("PAT rejected: missing required scopes", {
              missing: result.missing,
            })
            onReject(
              t("auth.errorPatMissingScopes", {
                scopes: result.missing.join(", "),
              }),
            )
            return
          }

          completeSignIn({
            access_token: token,
            scope: result.scopes,
            authMethod: "pat",
          })
        },
        onError: (err) => {
          if (err instanceof GitHubUserFetchError && err.status === 401) {
            log.warn("PAT rejected: 401 (invalid token)")
            onReject(t("auth.errorPatRejected401"))
            return
          }
          log.error("PAT validation failed", { err, record: true })
          onReject(formatError(t, err, "api.github.com"))
        },
        onSettled,
      })
    },
    [completeSignIn, validatePatMutation, t],
  )

  // On unmount mid-flow, abort the device poll loop so it doesn't run after
  // teardown.
  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  useEffect(() => {
    const storedToken = getStoredGithubToken()
    const storedClientId = getStoredGithubClientId()
    const storedScope = getStoredGithubScope()

    // The build-time client ID wins; localStorage is a dev-only fallback.
    if (!GITHUB_OAUTH_CLIENT_ID && storedClientId) {
      setClientId(storedClientId)
    }
    setTokenScope(storedScope)

    if (storedToken) {
      log.info("restored stored session")
      setToken(storedToken)
      setAuthMethod(getStoredAuthMethod())
      setScreen("authed")
    } else {
      // Dev-only: skip the sign-in screen when VITE_GITHUB_PAT holds a valid PAT
      // (see resolveDevAutoLoginPat), validated like the manual paste flow but
      // logged instead of prompted. runDevAutoLoginOnce is module-scoped (fires
      // once per page load and persists on success, surviving StrictMode/HMR
      // remounts); a ?code on the URL means a returning OAuth redirect owns this
      // load, so we defer to the code-exchange effect rather than both driving
      // completeSignIn.
      const hasOAuthCallback = new URLSearchParams(window.location.search).has(
        "code",
      )
      const envPat = resolveDevAutoLoginPat({
        isDev: import.meta.env.DEV,
        hasStoredToken: false,
        envPat: import.meta.env.VITE_GITHUB_PAT,
      })
      if (envPat && !hasOAuthCallback) {
        log.info("dev auto-login from VITE_GITHUB_PAT")
        setAutoLoginPending(true)
        // Runs once per page load (module-scoped) and persists the token on
        // success, so this completeSignIn is a fast path for the live mount, not
        // the only delivery mechanism — a remount that missed this callback
        // still restores the persisted session on its next startup read.
        void runDevAutoLoginOnce(envPat)
          .then((res) => {
            if (res)
              completeSignIn({
                access_token: res.token,
                scope: res.scope,
                authMethod: "pat",
              })
          })
          .finally(() => setAutoLoginPending(false))
      }
    }

    setHasLoadedStoredAuth(true)
    // Mount-once: reads one-time startup state (stored session / env PAT). The
    // dev auto-login is module-scoped (runDevAutoLoginOnce), so re-running this
    // effect can't re-fire it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (screen !== "device-prompt") return

    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 500)

    return () => window.clearInterval(timer)
  }, [screen])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get("code")
    const returnedState = params.get("state")

    // No code: recover a stranded "exchanging" screen — e.g., bfcache restored
    // this page after Back on GitHub's consent screen, leaving startWebFlow's
    // state with no code to exchange. Else the card spins forever (#oauth-hang).
    if (!code) {
      setScreen(recoverStrandedExchange)
      return
    }

    window.history.replaceState({}, "", window.location.pathname)

    const {
      verifier,
      expectedState,
      clientId: callbackClientId,
      returnTo,
    } = consumeOAuthSession()

    if (!returnedState || returnedState !== expectedState) {
      log.error("OAuth state mismatch — possible CSRF, aborting sign-in", {
        record: true,
      })
      setError(t("auth.errorStateMismatch"))
      setScreen("config")
      return
    }

    if (!verifier || !callbackClientId) {
      log.error("OAuth callback missing PKCE verifier/clientId", {
        record: true,
      })
      setError(t("auth.errorMissingPkce"))
      setScreen("config")
      return
    }

    log.info("OAuth callback received, exchanging code")
    setClientId(callbackClientId)
    persistGithubClientId(callbackClientId)

    setScreen("exchanging")
    setError(null)

    exchangeCodeMutation.mutate(
      {
        clientId: callbackClientId,
        code,
        verifier,
      },
      {
        onSuccess: (data) => {
          completeSignIn({ ...data, authMethod: "oauth" })
          // Defer the return until status is "authenticated" (effect below);
          // navigating now would race the router context and bounce through the
          // _authed guard (#71).
          pendingReturnToRef.current = returnTo
        },
        onError: (err) => {
          log.error("OAuth code exchange failed", { err, record: true })
          setError(formatError(t, err))
          setScreen("config")
        },
      },
    )
    // Mount-once by design: this consumes the one-time OAuth redirect (code +
    // state from the URL) and fires the single-use code exchange. Re-running on
    // completeSignIn/exchangeCodeMutation/t identity changes would re-attempt the
    // exchange with an already-spent code and fail — so the empty deps are
    // intentional, not an omission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A bfcache restore freezes React state as-is with no effect re-run, so the
  // mount effect above can't catch a stranded "exchanging" screen — pageshow
  // (persisted only) is the one hook that fires here (#oauth-hang).
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      if (new URLSearchParams(window.location.search).has("code")) return
      setScreen(recoverStrandedExchange)
    }
    window.addEventListener("pageshow", onPageShow)
    return () => window.removeEventListener("pageshow", onPageShow)
  }, [])

  const validateConfig = useCallback(
    (opts?: SignInOptions) => {
      const trimmedClientId = clientId.trim()

      if (!trimmedClientId) {
        setError(t("auth.errorClientIdMissing"))
        return null
      }

      persistGithubClientId(trimmedClientId)
      setError(null)

      return {
        clientId: trimmedClientId,
        // Elevation is one-shot: the broadened scope is chosen at call time and
        // never persisted, so a later fresh login drops back to base (#655).
        scope: opts?.elevated ? ELEVATED_GITHUB_SCOPE : DEFAULT_GITHUB_SCOPE,
      }
    },
    [clientId, t],
  )

  const startWebFlow = useCallback(
    async (opts?: WebSignInOptions) => {
      const config = validateConfig(opts)
      if (!config) return

      const elevated = opts?.elevated ?? false
      log.info("starting web (PKCE) sign-in flow", { elevated })
      setScreen("exchanging")

      const verifier = generateVerifier()
      const challenge = await deriveChallenge(verifier)
      const oauthState = randomBase64Url(16)

      // Stash the deep link in the OAuth session so it survives the GitHub
      // round-trip; restored after the code exchange (#71). A caller mid-task
      // (the elevation modal) passes its own path so the redirect returns there
      // instead of the dashboard; otherwise this is /login?redirect=.
      const returnTo =
        opts?.returnTo ??
        new URLSearchParams(window.location.search).get("redirect")

      saveOAuthSession({
        verifier,
        state: oauthState,
        clientId: config.clientId,
        scope: config.scope,
        returnTo,
      })

      window.location.href = buildGithubAuthorizeUrl({
        clientId: config.clientId,
        scope: config.scope,
        state: oauthState,
        challenge,
      })
    },
    [validateConfig],
  )

  const failDeviceFlow = useCallback((message: string) => {
    log.warn("device flow failed", { record: true })
    deviceGenRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setError(message)
    setDevice(null)
    setScreen(idleScreen(tokenRef.current))
  }, [])

  const startDevicePolling = useCallback(
    async (input: {
      clientId: string
      deviceCode: string
      expiresAt: number
      initialIntervalSeconds: number
    }) => {
      abortRef.current?.abort()

      const controller = new AbortController()
      abortRef.current = controller

      let intervalSeconds = input.initialIntervalSeconds
      let attempts = 0

      while (!controller.signal.aborted) {
        if (Date.now() > input.expiresAt) {
          failDeviceFlow(t("auth.errorDeviceExpired"))
          return
        }

        setDevice((current) =>
          current
            ? {
                ...current,
                intervalSeconds,
                nextPollAt: Date.now() + intervalSeconds * 1000,
              }
            : current,
        )

        await sleep(intervalSeconds * 1000, controller.signal)

        if (controller.signal.aborted) return

        attempts += 1

        setDevice((current) =>
          current
            ? {
                ...current,
                attempts,
              }
            : current,
        )

        let data

        try {
          data = await pollDeviceToken({
            clientId: input.clientId,
            deviceCode: input.deviceCode,
            signal: controller.signal,
          })
        } catch (err) {
          if (controller.signal.aborted) return
          failDeviceFlow(formatError(t, err))
          return
        }

        if (data.error === "authorization_pending") continue

        if (data.error === "slow_down") {
          log.debug("device poll: slow_down, backing off", {
            intervalSeconds: intervalSeconds + 5,
          })
          intervalSeconds += 5
          continue
        }

        if (data.error === "access_denied") {
          failDeviceFlow(t("auth.errorDeviceDeclined"))
          return
        }

        if (data.error === "expired_token") {
          failDeviceFlow(t("auth.errorDeviceExpired"))
          return
        }

        if (data.error) {
          failDeviceFlow(data.error_description || data.error)
          return
        }

        if (!data.access_token) {
          failDeviceFlow(t("auth.errorDeviceNoToken"))
          return
        }

        completeSignIn({
          access_token: data.access_token,
          scope: data.scope,
          authMethod: "oauth",
        })

        return
      }
    },
    [completeSignIn, failDeviceFlow, t],
  )

  const startDeviceFlow = useCallback(
    async (opts?: SignInOptions) => {
      const config = validateConfig(opts)
      if (!config) return

      const elevated = opts?.elevated ?? false
      log.info("starting device sign-in flow", { elevated })
      setError(null)

      // Capture the generation: a cancel (or navigation) while the request is in
      // flight bumps it, and the callbacks below must then do nothing.
      const generation = ++deviceGenRef.current

      requestDeviceCodeMutation.mutate(config, {
        onSuccess: (data) => {
          if (generation !== deviceGenRef.current) {
            log.info("device code issued after cancel, discarding")
            return
          }
          log.info("device code issued, awaiting authorization")
          const intervalSeconds = data.interval || 5
          const expiresAt = Date.now() + data.expires_in! * 1000

          setDevice({
            userCode: data.user_code!,
            verificationUri: data.verification_uri!,
            deviceCode: data.device_code!,
            expiresAt,
            intervalSeconds,
            attempts: 0,
            nextPollAt: Date.now() + intervalSeconds * 1000,
            progress: 0,
            elevated,
          })

          setScreen("device-prompt")

          void startDevicePolling({
            clientId: config.clientId,
            deviceCode: data.device_code!,
            expiresAt,
            initialIntervalSeconds: intervalSeconds,
          })
        },
        onError: (err) => {
          if (generation !== deviceGenRef.current) return
          failDeviceFlow(formatError(t, err))
        },
      })
    },
    [
      failDeviceFlow,
      requestDeviceCodeMutation,
      startDevicePolling,
      validateConfig,
      t,
    ],
  )

  const cancelDeviceFlow = useCallback(() => {
    deviceGenRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setDevice(null)
    setError(null)
    setScreen(idleScreen(tokenRef.current))
  }, [])

  const markDeviceCodeCopied = useCallback(() => {
    setDevice((current) =>
      current && current.progress < 1
        ? {
            ...current,
            progress: 1,
          }
        : current,
    )
  }, [])

  const markVerificationOpened = useCallback(() => {
    setDevice((current) =>
      current && current.progress < 2
        ? {
            ...current,
            progress: 2,
          }
        : current,
    )
  }, [])

  const startPatFlow = useCallback((tokenType: PatTokenType = "classic") => {
    setPatError(null)
    setPatTokenType(tokenType)
    setScreen("pat-prompt")
  }, [])

  const cancelPatFlow = useCallback(() => {
    setPatError(null)
    setScreen("config")
  }, [])

  const submitPat = useCallback(
    (rawToken: string) => {
      const token = rawToken.trim()
      if (!token) return

      setPatError(null)
      validateAndSignInWithPat(token, setPatError)
    },
    [validateAndSignInWithPat],
  )

  // Shared teardown for both a deliberate sign-out and an involuntary expiry.
  // `expired` flags the involuntary case so /login can explain the redirect.
  const clearSession = useCallback(
    (expired: boolean) => {
      if (expired) {
        // Involuntary teardown (a live 401): warn + record so a user's
        // diagnostics reflect why they were kicked out.
        log.warn("session expired, signing out", { record: true })
      } else {
        log.info("signing out")
      }
      abortRef.current?.abort()
      clearGithubToken()
      setToken(null)
      setTokenScope("")
      setAuthMethod(null)
      setDevice(null)
      setError(null)
      setScreen("config")
      setSessionExpired(expired)
      // Cancel in-flight ["github"] requests before evicting them so they don't
      // resolve into removed cache state after teardown.
      void queryClient.cancelQueries({ queryKey: ["github"] })
      queryClient.removeQueries({ queryKey: ["github"] })
    },
    [queryClient],
  )

  const signOut = useCallback(() => clearSession(false), [clearSession])

  // Called when a revoked/expired token is detected on a live API 401. Clears
  // the token so `status` flips to unauthenticated and the guard redirects to
  // /login. Guards on the in-memory token (authoritative) so a live 401 tears
  // down even if storage was cleared out-of-band. No-ops once the token is gone.
  const expireSession = useCallback(() => {
    if (!token) return
    clearSession(true)
  }, [clearSession, token])

  // Cold-reload teardown for a revoked token, gated by shouldExpireOnUserError
  // (401-only, matching GitHubProvider.onResponse) so a 403/transient error
  // can't wipe a valid token.
  useEffect(() => {
    if (shouldExpireOnUserError(githubUserQuery.error)) {
      expireSession()
    }
  }, [githubUserQuery.error, expireSession])

  const deviceStatus = useMemo(() => {
    if (!device) return null

    const remainingSeconds = Math.max(
      0,
      Math.floor((device.expiresAt - now) / 1000),
    )

    const nextPollSeconds = Math.max(
      0,
      Math.ceil((device.nextPollAt - now) / 1000),
    )

    const minutes = Math.floor(remainingSeconds / 60)
    const seconds = String(remainingSeconds % 60).padStart(2, "0")

    return {
      attempts: device.attempts,
      nextPollSeconds,
      expiresDisplay: `${minutes}:${seconds}`,
    }
  }, [device, now])

  const status = useMemo<AuthStatus>(
    () =>
      resolveAuthStatus({
        hasLoadedStoredAuth,
        hasToken: Boolean(token),
        isOnline,
        userQueryPending:
          githubUserQuery.isLoading || githubUserQuery.isPending,
        userQueryErrored: githubUserQuery.isError,
        userErrorExpiresToken: shouldExpireOnUserError(githubUserQuery.error),
        userErrorIsTransient: isTransientUserError(githubUserQuery.error),
        hasUser: Boolean(githubUserQuery.data),
        autoLoginPending,
      }),
    [
      hasLoadedStoredAuth,
      token,
      isOnline,
      githubUserQuery.isLoading,
      githubUserQuery.isPending,
      githubUserQuery.isError,
      githubUserQuery.error,
      githubUserQuery.data,
      autoLoginPending,
    ],
  )

  // Live isValidationStuck against the current /user query state (see its doc).
  const isValidatingStuck = useMemo(
    () =>
      isValidationStuck({
        hasToken: Boolean(token),
        isOnline,
        hasUser: Boolean(githubUserQuery.data),
        userQueryErrored: githubUserQuery.isError,
        userErrorIsTransient: isTransientUserError(githubUserQuery.error),
        userQueryFetching: githubUserQuery.isFetching,
      }),
    [
      token,
      isOnline,
      githubUserQuery.data,
      githubUserQuery.isError,
      githubUserQuery.error,
      githubUserQuery.isFetching,
    ],
  )

  const retryUserValidation = useCallback(() => {
    void githubUserQuery.refetch()
  }, [githubUserQuery])

  // Navigate to the stashed deep link once status is "authenticated", so the
  // target _authed guard sees an authenticated context instead of bouncing
  // through /login (#71). history.push (not navigate({ to })) preserves the
  // query — e.g., the ?k= accept key. A bad path degrades to the homepage.
  useEffect(() => {
    if (status !== "authenticated") return
    const returnTo = pendingReturnToRef.current
    if (!returnTo) return
    pendingReturnToRef.current = null
    try {
      router.history.push(returnTo)
    } catch {
      log.warn("invalid return-to path, falling back to home", {
        record: true,
      })
      router.history.push("/")
    }
  }, [status])

  return {
    screen,
    token,
    tokenScope,
    authMethod,
    error,
    device,
    deviceStatus,
    user: githubUserQuery.data ?? null,
    isLoadingUser: githubUserQuery.isLoading,
    isStartingWebFlow: screen === "exchanging",
    isRequestingDeviceCode: requestDeviceCodeMutation.isPending,
    startWebFlow,
    startDeviceFlow,
    cancelDeviceFlow,
    markDeviceCodeCopied,
    markVerificationOpened,
    startPatFlow,
    cancelPatFlow,
    submitPat,
    patError,
    patTokenType,
    isValidatingPat: validatePatMutation.isPending,
    signOut,
    expireSession,
    sessionExpired,
    status,
    isValidatingStuck,
    retryUserValidation,
    isOnline,
  }
}

type GitHubAuth = ReturnType<typeof useGithubAuthState>

const GitHubAuthContext = createContext<GitHubAuth | null>(null)

export function GitHubAuthProvider({ children }: PropsWithChildren) {
  const githubAuth = useGithubAuthState()

  return (
    <GitHubAuthContext.Provider value={githubAuth}>
      {children}
    </GitHubAuthContext.Provider>
  )
}

export function useGithubAuth() {
  const value = useContext(GitHubAuthContext)

  if (!value) {
    throw new Error("useGithubAuth must be used within GitHubAuthProvider")
  }

  return value
}
