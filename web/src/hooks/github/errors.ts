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
  // Raw X-GitHub-SSO response header, when present. GitHub sets this on a
  // 403 (and omits SSO-gated orgs from multi-org reads) when the token lacks a
  // live SAML SSO session for the org/enterprise. `null` when the header was
  // absent. See parseSsoAuthorizationUrl for extracting the authorization URL.
  ssoHeader: string | null
  // Raw X-Accepted-OAuth-Scopes response header, when present. On a 403 caused
  // by a scope gap, GitHub reports the scopes the endpoint *requires* here (vs
  // X-OAuth-Scopes, the scopes the token actually has). `null` when absent.
  // Used with `oauthScopes` to distinguish a real scope gap from an org
  // restriction — presence alone is NOT a gap (GitHub sends this header on most
  // responses); a gap is `acceptedScopes` not satisfied by `oauthScopes`.
  acceptedScopes: string | null
  // Raw X-OAuth-Scopes response header (the scopes the token actually holds),
  // when present. `null` for a fine-grained PAT or when absent. Compared against
  // `acceptedScopes` by `isScopeGap`.
  oauthScopes: string | null

  constructor(args: {
    status: number
    url: string
    message: string
    body: unknown
    rateLimit: GitHubRateLimit
    ssoHeader?: string | null
    acceptedScopes?: string | null
    oauthScopes?: string | null
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
  // for it. GitHub signals this with the X-GitHub-SSO header (a 403 carrying
  // `required; url=…`, or `partial-results; organizations=…` on multi-org reads).
  // Scoped to 403: GitHub only emits X-GitHub-SSO on a forbidden response, so a
  // header echoed on any other status (a 401 dead token, a 5xx/429 that a proxy
  // copied the header onto) is NOT an SSO gate and must not misroute the user.
  get isSsoRequired() {
    return this.status === 403 && this.ssoHeader !== null
  }

  // A 403 caused by the token missing a scope the endpoint requires — as opposed
  // to an org restriction, SAML gate, or rate limit (all also 403). GitHub sends
  // X-Accepted-OAuth-Scopes on most responses, so its mere presence is NOT a gap;
  // a real gap is when the accepted set has a requirement the token's granted
  // scopes (X-OAuth-Scopes) don't satisfy. When either header is absent we cannot
  // prove a gap, so this is false (fail closed — never mislabel a restriction as
  // a scope problem). An empty required set ("" — endpoint needs no scope) is
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
    // endpoint", so a gap is only when the token holds NONE of the accepted scopes.
    return !required.some((scope) => granted.has(scope))
  }

  // The GitHub SSO authorization URL to send the user to, if the header carried
  // one (`required; url=…`). Returns null for the `partial-results` shape or
  // when no header is present.
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
    // attacker-influenced origin or scheme (the header is from GitHub, but stay
    // defensive since we render this as a clickable redirect). The explicit
    // https: check makes the intent durable rather than relying on the
    // incidental fact that javascript:/data: URLs parse to an empty hostname.
    if (url.protocol !== "https:") return null
    if (url.hostname !== "github.com") return null
    return url.toString()
  } catch {
    return null
  }
}

// Shared React Query `retry` predicate for fail-closed role/permission reads: a
// definitive status (401 revoked/expired, 403 blocked, 404 not found / not a
// member — see isDefinitiveGitHubStatus) must NOT retry, while a transient
// 5xx/429/network blip self-heals (bounded to 2). Named for its behavior (retry
// only transient errors); the definitive set includes 401 as well as 403/404.
export function retryTransientGitHubError(
  failureCount: number,
  error: unknown,
): boolean {
  if (
    error instanceof GitHubAPIError &&
    isDefinitiveGitHubStatus(error.status)
  ) {
    return false
  }
  return failureCount < 2
}

// Statuses that are DEFINITIVE for a GitHub read — retrying cannot change the
// outcome, so the query should resolve immediately: 401 (revoked/expired
// credentials), 403 (blocked, incl. SAML-SSO-gated — see #66), 404 (absent).
// Any other failure (5xx / 429 / network) is treated as transient by the retry
// predicates above/below. Works off a bare status so it is shared across the
// bespoke GitHubUserFetchError and the canonical GitHubAPIError.
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
