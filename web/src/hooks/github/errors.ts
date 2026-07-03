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

  constructor(args: {
    status: number
    url: string
    message: string
    body: unknown
    rateLimit: GitHubRateLimit
  }) {
    super(args.message)
    this.name = "GitHubAPIError"
    this.status = args.status
    this.url = args.url
    this.body = args.body
    this.rateLimit = args.rateLimit
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
}

// Shared React Query `retry` predicate for fail-closed role/permission reads: a
// 404 (not found / not a member) or 403 (blocked) is DEFINITIVE and must NOT
// retry, while a transient 5xx/429/network blip self-heals (bounded to 2).
export function retryTransientNotFoundForbidden(
  failureCount: number,
  error: unknown,
): boolean {
  if (
    error instanceof GitHubAPIError &&
    (error.status === 404 || error.status === 403)
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
// bespoke GithubUserFetchError and the canonical GitHubAPIError.
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
