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

// Scopes split into two tiers so login stays least-privilege for everyone
// (teachers and students share one flow):
//
// - BASE is requested at every sign-in and is what REQUIRED_SCOPES enforces.
//   admin:org enables org-invite management + team writes; repo covers roster
//   commits and repo archiving; workflow commits the autograder shim.
// - ELEVATED (delete_repo) is destructive and requested only on demand, when a
//   teacher opts into an elevated action (today: Teardown Organization). It is
//   intentionally absent from BASE, so a student authorizing the app never
//   grants repo deletion, and REQUIRED_SCOPES never nags for it (#655). Add a
//   normally-required scope to BASE; add a destructive one to ELEVATED.
//
// The CLIs keep delete_repo opt-in as well.
export const BASE_GITHUB_SCOPES = [
  "read:user",
  "read:org",
  "repo",
  "workflow",
  "admin:org",
] as const

export const ELEVATED_GITHUB_SCOPES = ["delete_repo"] as const

// The scope string a normal (least-privilege) sign-in requests.
export const DEFAULT_GITHUB_SCOPE = BASE_GITHUB_SCOPES.join(" ")

// The scope string an elevated sign-in requests: base + the destructive scopes.
export const ELEVATED_GITHUB_SCOPE = [
  ...BASE_GITHUB_SCOPES,
  ...ELEVATED_GITHUB_SCOPES,
].join(" ")

// An org's OAuth app policy page, where owners approve apps or relax the
// restriction.
export const githubOrgOAuthPolicyUrl = (org: string) =>
  `https://github.com/organizations/${org}/settings/oauth_application_policy`

// Public OAuth app identifier (not a secret); injected at build time.
export const GITHUB_OAUTH_CLIENT_ID: string =
  import.meta.env.VITE_GITHUB_CLIENT_ID ?? ""

const GITHUB_OAUTH_APPS_URL =
  "https://github.com/settings/connections/applications"

// This app's own entry on the user's authorized-apps page — the only place the
// per-org "Grant" button lives (discussions #352, #403). Without an injected
// client id (self-hosted/dev builds) only the app list is knowable.
export const githubOAuthGrantUrl = (clientId = GITHUB_OAUTH_CLIENT_ID) =>
  clientId ? `${GITHUB_OAUTH_APPS_URL}/${clientId}` : GITHUB_OAUTH_APPS_URL
