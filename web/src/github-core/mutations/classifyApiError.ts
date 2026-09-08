import { GitHubAPIError } from "../errors"

// One rung of an ensure* status ladder: the first predicate the API error
// satisfies names the warning `reason`.
export type ErrorRung<R extends string> = [
  matches: (err: GitHubAPIError) => boolean,
  reason: R,
]

// Anything that is not a GitHubAPIError, or matches no rung, gets `fallback`
// (a reason, or null for callers that rethrow instead).
export function classifyApiError<R extends string, F>(
  err: unknown,
  rungs: ErrorRung<R>[],
  fallback: F,
): R | F {
  if (err instanceof GitHubAPIError) {
    for (const [matches, reason] of rungs) if (matches(err)) return reason
  }
  return fallback
}

export const forbidden = (err: GitHubAPIError) => err.isForbidden
export const notFound = (err: GitHubAPIError) => err.isNotFound
export const rateLimited = (err: GitHubAPIError) => err.isRateLimited
export const status = (code: number) => (err: GitHubAPIError) =>
  err.status === code
