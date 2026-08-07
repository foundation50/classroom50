// The fine-grained-PAT sign-in option (offered alongside the classic pre-fill in
// GitHubPatPrompt). A fine-grained token targets a single resource owner
// (target_name), so unlike a classic PAT it covers one org — classic stays the
// multi-org default; this is the tighter-security, single-org alternative.
//
// The permission set mirrors the teacher app's classic scopes:
//   repo       -> Contents + Administration (create/archive/delete repos) + Workflows
//   admin:org  -> Organization Administration + Members (team/invite management)
//   delete_repo-> covered by repository Administration: write
// Built with URLSearchParams (matching buildServiceTokenUrl in OrgSettingsPage)
// so reserved characters encode correctly. Kept as one exported recipe so the
// rendered permission list and the URL can't drift.

export const FINE_GRAINED_SIGNIN_PERMISSIONS = {
  administration: "write",
  contents: "write",
  workflows: "write",
  organization_administration: "write",
  members: "read",
} as const

// Human-readable permission lines for the prompt UI, derived from the same recipe
// so the on-screen list and the pre-filled URL share one source.
export const FINE_GRAINED_SIGNIN_PERMISSION_LABELS = [
  "Repository — Administration: Read and write",
  "Repository — Contents: Read and write",
  "Repository — Workflows: Read and write",
  "Organization — Administration: Read and write",
  "Organization — Members: Read",
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
