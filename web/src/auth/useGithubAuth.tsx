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
import { DEFAULT_GITHUB_SCOPE, GITHUB_OAUTH_CLIENT_ID } from "./constants"
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
import { isDefinitiveGitHubStatus } from "@/hooks/github/errors"
import router from "@/router"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_AUTH } from "@/lib/logScopes"
import { deriveChallenge, generateVerifier, randomBase64Url } from "./pkce"
import { missingScopes } from "./scopes"
import {
  clearGithubToken,
  consumeOAuthSession,
  getStoredGithubClientId,
  getStoredGithubScope,
  getStoredGithubToken,
  persistGithubClientId,
  persistGithubToken,
  saveOAuthSession,
} from "./storage"
import type { DeviceAuthState, GithubAuthScreen } from "./types"
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
    return t("auth.errorNetwork", { target: networkTarget })
  }

  // A server-provided message (e.g. an OAuth error_description) is already a
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

// Recover a stranded "exchanging" screen: with no ?code to exchange (fresh
// reload or a bfcache Back from GitHub's consent screen), the card would spin
// forever, so reset it to "config". Every other screen is left as-is.
export function recoverStrandedExchange(
  current: GithubAuthScreen,
): GithubAuthScreen {
  return current === "exchanging" ? "config" : current
}

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

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms)

    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// Holds all auth state. Instantiate only once, in GitHubAuthProvider; other
// consumers use the useGithubAuth() context hook below.
function useGithubAuthState() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const abortRef = useRef<AbortController | null>(null)
  // Deep link (#71) stashed at code-exchange, consumed by the status-driven
  // effect below so navigation runs against an authenticated router context.
  const pendingReturnToRef = useRef<string | null>(null)

  const [screen, setScreen] = useState<GithubAuthScreen>("config")
  const [clientId, setClientId] = useState(GITHUB_OAUTH_CLIENT_ID)
  const [token, setToken] = useState<string | null>(null)
  const [tokenScope, setTokenScope] = useState("")
  const [error, setError] = useState<string | null>(null)
  // Scoped to the PAT prompt so a token-entry failure surfaces on that screen
  // without disturbing the config screen's `error`.
  const [patError, setPatError] = useState<string | null>(null)
  const [device, setDevice] = useState<DeviceAuthState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [hasLoadedStoredAuth, setHasLoadedStoredAuth] = useState(false)
  // Set when a live API 401 (revoked/expired token) tears the session down, so
  // /login can explain why the user was signed out. A deliberate signOut()
  // clears it.
  const [sessionExpired, setSessionExpired] = useState(false)

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
    (data: { access_token: string; scope?: string }) => {
      log.info("sign-in complete, token acquired")
      persistGithubToken(data.access_token, data.scope || "")
      setToken(data.access_token)
      setTokenScope(data.scope || "")
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
      setScreen("authed")
    }

    setHasLoadedStoredAuth(true)
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

    // No code: recover a stranded "exchanging" screen — e.g. bfcache restored
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
          completeSignIn(data)
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

  const validateConfig = useCallback(() => {
    const trimmedClientId = clientId.trim()

    if (!trimmedClientId) {
      setError(t("auth.errorClientIdMissing"))
      return null
    }

    persistGithubClientId(trimmedClientId)
    setError(null)

    return {
      clientId: trimmedClientId,
      scope: DEFAULT_GITHUB_SCOPE,
    }
  }, [clientId, t])

  const startWebFlow = useCallback(async () => {
    const config = validateConfig()
    if (!config) return

    log.info("starting web (PKCE) sign-in flow")
    setScreen("exchanging")

    const verifier = generateVerifier()
    const challenge = await deriveChallenge(verifier)
    const oauthState = randomBase64Url(16)

    // Stash the deep link (from /login?redirect=) in the OAuth session so it
    // survives the GitHub round-trip; restored after the code exchange (#71).
    const returnTo = new URLSearchParams(window.location.search).get("redirect")

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
  }, [validateConfig])

  const failDeviceFlow = useCallback((message: string) => {
    log.warn("device flow failed", { record: true })
    abortRef.current?.abort()
    abortRef.current = null
    setError(message)
    setDevice(null)
    setScreen("config")
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

        completeSignIn({ access_token: data.access_token, scope: data.scope })

        return
      }
    },
    [completeSignIn, failDeviceFlow, t],
  )

  const startDeviceFlow = useCallback(async () => {
    const config = validateConfig()
    if (!config) return

    log.info("starting device sign-in flow")
    setError(null)

    requestDeviceCodeMutation.mutate(config, {
      onSuccess: (data) => {
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
        failDeviceFlow(formatError(t, err))
      },
    })
  }, [
    failDeviceFlow,
    requestDeviceCodeMutation,
    startDevicePolling,
    validateConfig,
    t,
  ])

  const cancelDeviceFlow = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setDevice(null)
    setError(null)
    setScreen("config")
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

  const startPatFlow = useCallback(() => {
    setPatError(null)
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

      log.info("validating personal access token")
      validatePatMutation.mutate(token, {
        onSuccess: ({ scopes }) => {
          const result = classifyPatResult(scopes)

          // A fine-grained PAT (null header) carries no verifiable scopes; its
          // per-resource permissions can't be checked here and typically fail
          // mid-operation, so block it at entry rather than sign in on a token
          // we can't vet.
          if (result.kind === "fine-grained") {
            log.warn("PAT rejected: fine-grained (unverifiable scopes)")
            setPatError(t("auth.errorPatFineGrained"))
            return
          }

          if (result.kind === "missing") {
            log.warn("PAT rejected: missing required scopes", {
              missing: result.missing,
            })
            setPatError(
              t("auth.errorPatMissingScopes", {
                scopes: result.missing.join(", "),
              }),
            )
            return
          }

          completeSignIn({ access_token: token, scope: result.scopes })
        },
        onError: (err) => {
          if (err instanceof GitHubUserFetchError && err.status === 401) {
            log.warn("PAT rejected: 401 (invalid token)")
            setPatError(t("auth.errorPatRejected401"))
            return
          }
          log.error("PAT validation failed", { err, record: true })
          setPatError(formatError(t, err, "api.github.com"))
        },
      })
    },
    [completeSignIn, validatePatMutation, t],
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

  const status = useMemo<AuthStatus>(() => {
    if (!hasLoadedStoredAuth) {
      return "loading"
    }

    if (!token) {
      return "unauthenticated"
    }

    if (githubUserQuery.isLoading || githubUserQuery.isPending) {
      return "loading"
    }

    if (githubUserQuery.isError || !githubUserQuery.data) {
      return "unauthenticated"
    }

    return "authenticated"
  }, [
    hasLoadedStoredAuth,
    token,
    githubUserQuery.isLoading,
    githubUserQuery.isPending,
    githubUserQuery.isError,
    githubUserQuery.data,
  ])

  // Navigate to the stashed deep link once status is "authenticated", so the
  // target _authed guard sees an authenticated context instead of bouncing
  // through /login (#71). history.push (not navigate({ to })) preserves the
  // query — e.g. the ?k= accept key. A bad path degrades to the homepage.
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
    isValidatingPat: validatePatMutation.isPending,
    signOut,
    expireSession,
    sessionExpired,
    status,
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
