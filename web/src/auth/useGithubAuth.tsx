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
import { DEFAULT_GITHUB_SCOPE, GITHUB_OAUTH_CLIENT_ID } from "./constants"
import {
  buildGithubAuthorizeUrl,
  exchangeWebCode,
  pollDeviceToken,
  requestDeviceCode,
} from "./github-oauth-api"
import { fetchGithubUser, GitHubUserFetchError } from "./github-user-api"
import { isDefinitiveGitHubStatus } from "@/hooks/github/errors"
import router from "@/router"
import { deriveChallenge, generateVerifier, randomBase64Url } from "./pkce"
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

function formatError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)

  if (
    message.toLowerCase().includes("failed to fetch") ||
    message.toLowerCase().includes("networkerror")
  ) {
    return "Network error reaching the Cloudflare Worker proxy; it may be down or unreachable."
  }

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
  const abortRef = useRef<AbortController | null>(null)
  // Deep link (#71) stashed at code-exchange, consumed by the status-driven
  // effect below so navigation runs against an authenticated router context.
  const pendingReturnToRef = useRef<string | null>(null)

  const [screen, setScreen] = useState<GithubAuthScreen>("config")
  const [clientId, setClientId] = useState(GITHUB_OAUTH_CLIENT_ID)
  const [token, setToken] = useState<string | null>(null)
  const [tokenScope, setTokenScope] = useState("")
  const [error, setError] = useState<string | null>(null)
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

  // Shared landing for both web and device flows. Goes straight to the authed
  // screen and prefetches the profile; once it resolves, status flips to
  // authenticated and the /login guard redirects into the app. Until then the
  // card shows a spinner (no interstitial success splash).
  const completeSignIn = useCallback(
    (data: { access_token: string; scope?: string }) => {
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
      setError("State mismatch -- possible CSRF. Please try signing in again.")
      setScreen("config")
      return
    }

    if (!verifier || !callbackClientId) {
      setError(
        "Missing PKCE verifier or client ID. Please try signing in again.",
      )
      setScreen("config")
      return
    }

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
          setError(formatError(err))
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
      setError(
        "GitHub OAuth client ID is not configured (VITE_GITHUB_CLIENT_ID).",
      )
      return null
    }

    persistGithubClientId(trimmedClientId)
    setError(null)

    return {
      clientId: trimmedClientId,
      scope: DEFAULT_GITHUB_SCOPE,
    }
  }, [clientId])

  const startWebFlow = useCallback(async () => {
    const config = validateConfig()
    if (!config) return

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
          failDeviceFlow("Device code expired. Please try again.")
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
          failDeviceFlow(formatError(err))
          return
        }

        if (data.error === "authorization_pending") continue

        if (data.error === "slow_down") {
          intervalSeconds += 5
          continue
        }

        if (data.error === "access_denied") {
          failDeviceFlow("You declined the authorization request.")
          return
        }

        if (data.error === "expired_token") {
          failDeviceFlow("Device code expired. Please try again.")
          return
        }

        if (data.error) {
          failDeviceFlow(data.error_description || data.error)
          return
        }

        if (!data.access_token) {
          failDeviceFlow(
            "Token endpoint returned no access_token and no error.",
          )
          return
        }

        completeSignIn({ access_token: data.access_token, scope: data.scope })

        return
      }
    },
    [completeSignIn, failDeviceFlow],
  )

  const startDeviceFlow = useCallback(async () => {
    const config = validateConfig()
    if (!config) return

    setError(null)

    requestDeviceCodeMutation.mutate(config, {
      onSuccess: (data) => {
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
        failDeviceFlow(formatError(err))
      },
    })
  }, [
    failDeviceFlow,
    requestDeviceCodeMutation,
    startDevicePolling,
    validateConfig,
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

  // Shared teardown for both a deliberate sign-out and an involuntary expiry.
  // `expired` flags the involuntary case so /login can explain the redirect.
  const clearSession = useCallback(
    (expired: boolean) => {
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
