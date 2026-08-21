// Split a GitHub `full_name` ("owner/repo") into its halves. Null when the shape
// is anything else, so a caller falls back rather than inventing a name.
export function splitFullName(
  fullName: string | undefined,
): { owner: string; repo: string } | null {
  const parts = fullName?.split("/")
  if (!parts || parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], repo: parts[1] }
}

// GitHub logins and repo names are limited to this charset, so anything else in a
// ref is a typo or an injection attempt — notably `..`, which would otherwise
// walk up a request path built by interpolation.
const SEGMENT = /^[A-Za-z0-9._-]+$/

export function isValidRepoSegment(segment: string): boolean {
  return SEGMENT.test(segment) && segment !== "." && segment !== ".."
}
