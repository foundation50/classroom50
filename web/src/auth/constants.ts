export const GITHUB_AUTH_STORAGE = {
  TOKEN: "gh_access_token",
  CLIENT_ID: "gh_client_id",
  SCOPE_GRANTED: "gh_scope_granted",
} as const

export const GITHUB_AUTH_SESSION = {
  VERIFIER: "gh_pkce_verifier",
  STATE: "gh_oauth_state",
  CLIENT_ID: "gh_oauth_client_id",
  SCOPE: "gh_oauth_scope",
  // Deep link to return to after sign-in; /login's redirect_uri can't carry it
  // across the GitHub round-trip, so it rides the session instead (#71).
  RETURN_TO: "gh_oauth_return_to",
} as const

// Scopes: admin:org enables org-invite management + team writes; repo covers
// roster commits and repo archiving; delete_repo lets teardown delete repos
// (else deletion 403s and callers fall back to archiving). delete_repo is
// requested here for the GUI; the CLIs keep it opt-in.
export const DEFAULT_GITHUB_SCOPE =
  "read:user read:org repo workflow admin:org delete_repo"

// An org's OAuth app policy page, where owners approve apps or relax the
// restriction.
export const githubOrgOAuthPolicyUrl = (org: string) =>
  `https://github.com/organizations/${org}/settings/oauth_application_policy`

// Public OAuth app identifier (not a secret); injected at build time.
export const GITHUB_OAUTH_CLIENT_ID: string =
  import.meta.env.VITE_GITHUB_CLIENT_ID ?? ""

export const GITHUB_OAUTH_WORKER_BASE =
  import.meta.env.VITE_GITHUB_OAUTH_WORKER_BASE ??
  "https://tiny-bonus-7dc1.fifty-foundation.workers.dev"
