// Custom Pages base-URL helpers for orgs with a custom GitHub Pages domain.
// github.io answers such an org with a 301 the browser's CORS check rejects
// (foundation50/classroom50#776), so classroom.json / the team-description
// bootstrap record can carry `pages_base_url` — everything before the
// `/<classroom>[/<secret>]/...` segment — and readers fetch it directly,
// falling back to the github.io default. Kept in lockstep with the CLI's
// configrepo.ValidatePagesBaseURL and the classroom-v1 / classroom-team-v1
// JSON schemas.

import { CONFIG_REPO } from "./configRepo"

// Mirrors contract.PagesBaseURLPattern (cli/shared) and both schemas' pattern.
export const PAGES_BASE_URL_PATTERN = /^https:\/\/[^\s?#]{1,110}$/

// A bare hostname a teacher may type instead of a full URL: dot-separated
// labels of [a-z0-9-], no scheme or path. Deliberately requires at least one
// dot — a custom Pages domain is always a registrable name, and the dot is
// what disambiguates "they typed a domain" from a malformed URL.
const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

// isValidPagesBaseUrl reports whether a value is a valid NORMALIZED base URL:
// the pattern (https, no whitespace/query/fragment, bounded) plus the
// invariants the pattern can't express — no trailing slash (URL builders
// append `/<classroom>/...`) and no userinfo. Empty is NOT valid; callers that
// allow "no custom domain" branch on emptiness first. Mirrors the CLI's
// ValidatePagesBaseURL — keep in lockstep.
export function isValidPagesBaseUrl(value: string): boolean {
  if (!PAGES_BASE_URL_PATTERN.test(value)) return false
  if (value.endsWith("/")) return false
  try {
    const url = new URL(value)
    return url.hostname !== "" && url.username === "" && url.password === ""
  } catch {
    return false
  }
}

// normalizePagesBaseUrl turns what a teacher typed into the stored form, or
// null when it can't be one:
//   - "" -> "" (clear the setting)
//   - a bare domain (`cs.example.edu`) -> `https://cs.example.edu/classroom50`,
//     the layout GitHub serves for an org-root custom domain (the common case);
//   - a full https URL -> verbatim minus any trailing slash, for the rarer
//     CNAME-on-the-classroom50-repo layout where the repo segment is absent.
export function normalizePagesBaseUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === "") return ""

  if (!trimmed.includes("://")) {
    const host = trimmed.toLowerCase().replace(/\/+$/, "")
    if (!HOSTNAME_PATTERN.test(host)) return null
    const candidate = `https://${host}/${CONFIG_REPO}`
    return isValidPagesBaseUrl(candidate) ? candidate : null
  }

  const candidate = trimmed.replace(/\/+$/, "")
  return isValidPagesBaseUrl(candidate) ? candidate : null
}
