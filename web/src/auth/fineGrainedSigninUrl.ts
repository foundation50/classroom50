// Pre-filled fine-grained-PAT sign-in option, offered alongside the classic
// pre-fill in GitHubPatPrompt. A fine-grained token targets a single resource
// owner (target_name), so unlike a classic PAT it covers one org: classic stays
// the multi-org default; this is the tighter-security, single-org alternative.
//
// The single source of truth for the teacher-app permissions a fine-grained
// sign-in token needs: each entry carries its GitHub API param key, the display
// group/name/access shown in the prompt, and the access level requested. Both
// the pre-filled URL params and the human-readable labels are derived from this
// one list, so adding a permission can't leave the URL and the on-screen list
// out of sync.
//
// The set mirrors the classic scopes and every endpoint the app actually calls
// (audited against github-core + domain flows):
//   repo        -> Contents + Administration (create/rename/archive/delete repos,
//                  branch protection, collaborators) + Workflows (commit shims)
//   admin:org   -> Organization Administration (org defaults lockdown, Actions
//                  policy/kill switch, rulesets) + Members: write (invite/remove
//                  members AND classroom-team CRUD, GitHub groups team
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
type PermissionAccess = "read" | "write"

type FineGrainedPermission = {
  // GitHub's fine-grained-token query-param key (e.g. "administration").
  key: string
  // Display grouping on GitHub's token page.
  group: "Repository" | "Organization"
  // Human-readable permission name.
  name: string
  access: PermissionAccess
}

const FINE_GRAINED_PERMISSIONS: readonly FineGrainedPermission[] = [
  {
    key: "administration",
    group: "Repository",
    name: "Administration",
    access: "write",
  },
  { key: "contents", group: "Repository", name: "Contents", access: "write" },
  { key: "workflows", group: "Repository", name: "Workflows", access: "write" },
  { key: "pages", group: "Repository", name: "Pages", access: "write" },
  { key: "secrets", group: "Repository", name: "Secrets", access: "write" },
  { key: "variables", group: "Repository", name: "Variables", access: "write" },
  { key: "actions", group: "Repository", name: "Actions", access: "write" },
  {
    key: "pull_requests",
    group: "Repository",
    name: "Pull requests",
    access: "write",
  },
  { key: "issues", group: "Repository", name: "Issues", access: "write" },
  {
    key: "organization_administration",
    group: "Organization",
    name: "Administration",
    access: "write",
  },
  { key: "members", group: "Organization", name: "Members", access: "write" },
  {
    key: "organization_plan",
    group: "Organization",
    name: "Plan",
    access: "read",
  },
]

const ACCESS_LABEL: Record<PermissionAccess, string> = {
  read: "Read-only",
  write: "Read and write",
}

// Human-readable permission lines for the prompt UI, derived from the recipe
// above so the on-screen list and the pre-filled URL can't drift.
export const FINE_GRAINED_SIGNIN_PERMISSION_LABELS =
  FINE_GRAINED_PERMISSIONS.map(
    (p) => `${p.group}, ${p.name}: ${ACCESS_LABEL[p.access]}`,
  )

// The token-creation query params (param key -> access), derived from the recipe.
// Exported so the URL builder and its test share one source.
export const FINE_GRAINED_SIGNIN_PERMISSIONS: Record<string, PermissionAccess> =
  Object.fromEntries(FINE_GRAINED_PERMISSIONS.map((p) => [p.key, p.access]))

// Pre-filled fine-grained-PAT creation URL for teacher sign-in. `org` becomes
// the resource owner (target_name); an empty/absent org yields a blank
// target_name (the teacher then picks the resource owner on GitHub), matching
// how buildServiceTokenUrl tolerates a missing org. Built with URLSearchParams
// (matching buildServiceTokenUrl in OrgSettingsPage) so reserved characters
// encode correctly, and the permission params come from the same recipe as the
// on-screen labels so the two can't drift.
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
