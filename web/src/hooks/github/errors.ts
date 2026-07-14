import { logger } from "@/lib/logger"
import { LOG_SCOPE_GITHUB_CLIENT } from "@/lib/logScopes"

// Lazy so this module can be imported by logger.ts's dependency graph without a
// top-level circular-init hazard: logger.ts -> activityStore.ts -> errors.ts,
// so at errors.ts eval time the `logger` export is still undefined. Verified:
// an eager `logger.scope(...)` here throws "Cannot read properties of undefined
// (reading 'scope')" on import. Keep lazy.
let logInstance: ReturnType<typeof logger.scope> | null = null
const log = () => (logInstance ??= logger.scope(LOG_SCOPE_GITHUB_CLIENT))

export type GitHubRateLimit = {
  limit: number | null
  remaining: number | null
  used: number | null
  reset: number | null
  resource: string | null
  retryAfter: number | null
}
export class GitHubAPIError extends Error {
  status: number
  url: string
  body: unknown
  rateLimit: GitHubRateLimit
  // Raw X-GitHub-SSO response header, when present. GitHub sets this on a 403
  // (and omits SSO-gated orgs from multi-org reads) when the token lacks a live
  // SAML SSO session for the org/enterprise. `null` when absent. See
  // parseSsoAuthorizationUrl for extracting the authorization URL.
  ssoHeader: string | null
  // Raw X-Accepted-OAuth-Scopes response header, when present. On a scope-gap
  // 403, GitHub reports the scopes the endpoint *requires* here (vs
  // X-OAuth-Scopes, what the token has). `null` when absent. Used with
  // `oauthScopes` to tell a real scope gap from an org restriction — presence
  // alone is NOT a gap (GitHub sends it on most responses).
  acceptedScopes: string | null
  // Raw X-OAuth-Scopes response header (the scopes the token actually holds),
  // when present. `null` for a fine-grained PAT or when absent. Compared against
  // `acceptedScopes` by `isScopeGap`.
  oauthScopes: string | null
  // X-GitHub-Request-Id, the id GitHub stamps on every response. Non-sensitive
  // and the fastest way for GitHub support (or the maintainer correlating with
  // the audit log) to find the exact failing request. `null` when absent.
  requestId: string | null

  constructor(args: {
    status: number
    url: string
    message: string
    body: unknown
    rateLimit: GitHubRateLimit
    ssoHeader?: string | null
    acceptedScopes?: string | null
    oauthScopes?: string | null
    requestId?: string | null
  }) {
    super(args.message)
    this.name = "GitHubAPIError"
    this.status = args.status
    this.url = args.url
    this.body = args.body
    this.rateLimit = args.rateLimit
    this.ssoHeader = args.ssoHeader ?? null
    this.acceptedScopes = args.acceptedScopes ?? null
    this.oauthScopes = args.oauthScopes ?? null
    this.requestId = args.requestId ?? null
  }

  get isNotFound() {
    return this.status === 404
  }

  get isForbidden() {
    return this.status === 403
  }

  get isUnauthorized() {
    return this.status === 401
  }

  get isRateLimited() {
    return (
      this.status === 429 ||
      (this.status === 403 &&
        (this.rateLimit.remaining === 0 || this.rateLimit.retryAfter !== null))
    )
  }

  // The org/enterprise enforces SAML SSO and this token has no live SSO session
  // for it. GitHub signals this via X-GitHub-SSO (a 403 carrying `required;
  // url=…`, or `partial-results; organizations=…` on multi-org reads). Scoped to
  // 403: GitHub only emits X-GitHub-SSO on a forbidden response, so a header
  // echoed on any other status (a 401 dead token, a proxy-copied 5xx/429) is NOT
  // an SSO gate and must not misroute the user.
  get isSsoRequired() {
    return this.status === 403 && this.ssoHeader !== null
  }

  // A 403 caused by the token missing a scope the endpoint requires — vs an org
  // restriction, SAML gate, or rate limit (all also 403). GitHub sends
  // X-Accepted-OAuth-Scopes on most responses, so its mere presence is NOT a
  // gap; a real gap is when the accepted set has a requirement the token's
  // granted scopes (X-OAuth-Scopes) don't satisfy. When either header is absent
  // we can't prove a gap, so false (fail closed). An empty required set ("") is
  // never a gap.
  get isScopeGap() {
    if (this.status !== 403) return false
    if (this.acceptedScopes === null || this.oauthScopes === null) return false
    const parse = (h: string) =>
      h
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    const required = parse(this.acceptedScopes)
    if (required.length === 0) return false
    const granted = new Set(parse(this.oauthScopes))
    // GitHub treats X-Accepted-OAuth-Scopes as "any one of these satisfies the
    // endpoint", so a gap is only when the token holds NONE of them.
    return !required.some((scope) => granted.has(scope))
  }

  // The GitHub SSO authorization URL to send the user to, if the header carried
  // one (`required; url=…`). Null for the `partial-results` shape or when no
  // header is present.
  get ssoAuthorizationUrl() {
    return parseSsoAuthorizationUrl(this.ssoHeader)
  }
}

// Extract the authorization URL from an X-GitHub-SSO header value. GitHub uses
// two shapes:
//   - `required; url=https://github.com/orgs/<org>/sso?authorization_request=…`
//     (or `enterprises/<ent>/sso`) — a single-org read the token can't see.
//   - `partial-results; organizations=21955855,20582480` — a multi-org read
//     that silently omitted SSO-gated orgs; carries org IDs, not a URL.
// Returns the URL for the first shape, or null otherwise.
export function parseSsoAuthorizationUrl(
  ssoHeader: string | null | undefined,
): string | null {
  if (!ssoHeader) return null
  const match = ssoHeader.match(/url=(\S+)/)
  if (!match) return null
  try {
    const url = new URL(match[1])
    // Only ever hand back an https://github.com SSO URL, never an
    // attacker-influenced origin or scheme (the header is from GitHub, but we
    // render this as a clickable redirect). The explicit https: check makes the
    // intent durable rather than relying on javascript:/data: URLs parsing to an
    // empty hostname.
    if (url.protocol !== "https:") return null
    if (url.hostname !== "github.com") return null
    return url.toString()
  } catch {
    log().debug("unparseable SSO authorization URL")
    return null
  }
}

// Shared React Query `retry` predicate for fail-closed role/permission reads: a
// definitive status (401 revoked/expired, 403 blocked, 404 not found / not a
// member — see isDefinitiveGitHubStatus) must NOT retry, while a transient
// 5xx/429/network blip self-heals (bounded to 2).
export function retryTransientGitHubError(
  failureCount: number,
  error: unknown,
): boolean {
  if (
    error instanceof GitHubAPIError &&
    isDefinitiveGitHubStatus(error.status)
  ) {
    log().debug("retry suppressed (definitive status)", {
      status: error.status,
    })
    return false
  }
  const willRetry = failureCount < 2
  if (willRetry) {
    log().debug("retrying transient error", { failureCount })
  }
  return willRetry
}

// Statuses that are DEFINITIVE for a GitHub read — retrying can't change the
// outcome, so the query resolves immediately: 401 (revoked/expired), 403
// (blocked, incl. SAML-SSO-gated — see #66), 404 (absent). Any other failure
// (5xx / 429 / network) is transient per the retry predicates. Works off a bare
// status so it's shared across GitHubUserFetchError and GitHubAPIError.
export function isDefinitiveGitHubStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404
}

export function readGitHubRateLimitHeaders(res: Response): GitHubRateLimit {
  const numberHeader = (name: string) => {
    const value = res.headers.get(name)
    return value === null ? null : Number(value)
  }

  return {
    limit: numberHeader("x-ratelimit-limit"),
    remaining: numberHeader("x-ratelimit-remaining"),
    used: numberHeader("x-ratelimit-used"),
    reset: numberHeader("x-ratelimit-reset"),
    resource: res.headers.get("x-ratelimit-resource"),
    retryAfter: numberHeader("retry-after"),
  }
}

// Run a GitHub read/write, swallowing a tolerated error into `fallback` instead
// of throwing — the "absent reads as empty/none" idiom, unified so call sites
// stop re-spelling the `instanceof GitHubAPIError && status === 404` guard.
// Defaults to 404-only; pass `predicate` to widen (e.g. 403||404 for a list a
// caller can't read) and `onCaught` for a side-effect (e.g. log.warn) before
// returning. Any error the predicate rejects, and any non-GitHubAPIError throw,
// rethrows unchanged.
//
// `F` defaults to `T` but is separate so a fallback wider than the op result
// (e.g. op yields `GitHubRepo[]`, fallback is `null`) types as `T | F` without a
// cast at the call site.
export async function tolerateGitHubError<T, F = T>(
  op: () => Promise<T>,
  fallback: F,
  opts?: {
    predicate?: (err: GitHubAPIError) => boolean
    onCaught?: (err: GitHubAPIError) => void
  },
): Promise<T | F> {
  try {
    return await op()
  } catch (err) {
    const tolerates = opts?.predicate ?? ((e: GitHubAPIError) => e.isNotFound)
    if (err instanceof GitHubAPIError && tolerates(err)) {
      opts?.onCaught?.(err)
      return fallback
    }
    throw err
  }
}
