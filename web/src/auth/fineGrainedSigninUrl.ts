// The fine-grained-PAT sign-in option (offered alongside the classic pre-fill in
// GitHubPatPrompt). A fine-grained token targets a single resource owner
// (target_name), so unlike a classic PAT it covers one org — classic stays the
// multi-org default; this is the tighter-security, single-org alternative.
//
// The permission set mirrors the teacher app's classic scopes and every endpoint
// the app actually calls (audited against github-core + domain flows):
//   repo        -> Contents + Administration (create/rename/archive/delete repos,
//                  branch protection, collaborators) + Workflows (commit shims)
//   admin:org   -> Organization Administration (org defaults lockdown, Actions
//                  policy/kill switch, rulesets) + Members: write (invite/remove
//                  members AND classroom-team CRUD — GitHub groups team
//                  management under the Members permission)
//   delete_repo -> covered by repository Administration: write
//   Pages       -> org-setup reads GET .../pages and PUTs the Pages config
//                  (a read-only Pages permission 403s the pre-flight check).
//   Secrets     -> saving the service token PUTs an Actions secret (putRepoSecret)
//   Variables   -> the same save writes the token-expiry Actions variable
//   Actions     -> the pre-flight reads repo Actions perms, and collect-scores /
//                  regrade dispatch workflows + rerun failed jobs (write)
//   Pull requests / Issues -> Feedback PRs open a PR and manage its labels
//                  (GitHub gates label writes behind the Issues permission)
//   Org plan (read) -> the spending-cap audit reads .../billing/budgets; this is
//                  advisory-only (never gates), but it clears the "unreadable
//                  budget" row for a fine-grained session.
// Built with URLSearchParams (matching buildServiceTokenUrl in OrgSettingsPage)
// so reserved characters encode correctly. Kept as one exported recipe so the
// rendered permission list and the URL can't drift.

export const FINE_GRAINED_SIGNIN_PERMISSIONS = {
  administration: "write",
  contents: "write",
  workflows: "write",
  pages: "write",
  secrets: "write",
  variables: "write",
  actions: "write",
  pull_requests: "write",
  issues: "write",
  organization_administration: "write",
  members: "write",
  organization_plan: "read",
} as const

// Human-readable permission lines for the prompt UI, derived from the same recipe
// so the on-screen list and the pre-filled URL share one source.
export const FINE_GRAINED_SIGNIN_PERMISSION_LABELS = [
  "Repository — Administration: Read and write",
  "Repository — Contents: Read and write",
  "Repository — Workflows: Read and write",
  "Repository — Pages: Read and write",
  "Repository — Secrets: Read and write",
  "Repository — Variables: Read and write",
  "Repository — Actions: Read and write",
  "Repository — Pull requests: Read and write",
  "Repository — Issues: Read and write",
  "Organization — Administration: Read and write",
  "Organization — Members: Read and write",
  "Organization — Plan: Read-only",
] as const

// Pre-filled fine-grained-PAT creation URL for teacher sign-in. `org` becomes
// the resource owner (target_name); an empty/absent org yields a blank
// target_name (the teacher then picks the resource owner on GitHub), matching
// how buildServiceTokenUrl tolerates a missing org.
export function buildFineGrainedSigninUrl(org?: string): string {
  return (
    "https://github.com/settings/personal-access-tokens/new?" +
    new URLSearchParams({
      name: "Classroom 50",
      description: "Classroom 50 teacher sign-in",
      target_name: org ?? "",
      ...FINE_GRAINED_SIGNIN_PERMISSIONS,
    }).toString()
  )
}
