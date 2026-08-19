import { BASE_GITHUB_SCOPES } from "./constants"

// The scopes a normal sign-in must hold. Sourced from the same array the login
// scope string is built from, so the two can't drift.
export const REQUIRED_SCOPES: readonly string[] = BASE_GITHUB_SCOPES

// GitHub normalizes granted scopes and a broader scope implies narrower ones,
// so we map each grantable scope -> the scopes it also satisfies (e.g., `repo`
// covers `repo:status`, `admin:org` covers `read:org`); unknown scopes satisfy
// only themselves. Biased toward over-satisfying: a missed gap is softer than a
// spurious banner a re-auth can't clear.
const SCOPE_IMPLICATIONS: Record<string, readonly string[]> = {
  repo: [
    "repo:status",
    "repo_deployment",
    "public_repo",
    "repo:invite",
    "security_events",
  ],
  "admin:org": ["write:org", "read:org", "manage_runners:org"],
  "write:org": ["read:org"],
  user: ["read:user", "user:email", "user:follow"],
}

// Expand a raw granted-scope string (space- or comma-delimited) into the full
// set of scopes it satisfies, including implied sub-scopes.
export function expandScopes(granted: string): Set<string> {
  const direct = granted.split(/[\s,]+/).filter(Boolean)
  const expanded = new Set<string>()

  for (const scope of direct) {
    expanded.add(scope)
    for (const implied of SCOPE_IMPLICATIONS[scope] ?? []) {
      expanded.add(implied)
    }
  }

  return expanded
}

// Required scopes not satisfied by the expanded granted set. Empty granted ->
// every required scope reported missing; callers decide whether an absent
// signal should suppress the warning (see useMissingScopes).
export function missingScopes(granted: string): string[] {
  return missingFrom(REQUIRED_SCOPES, granted)
}

// Which of `required` the granted string doesn't satisfy, so callers with their
// own required set (e.g. the elevated scopes) reuse one implication-aware check.
export function missingFrom(
  required: readonly string[],
  granted: string,
): string[] {
  const have = expandScopes(granted)
  return required.filter((scope) => !have.has(scope))
}
