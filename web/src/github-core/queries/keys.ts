import type { QueryClient } from "@tanstack/react-query"

// The cache-key factory for every github-core read. This is the leaf of the
// queries module: every *Query sub-module imports these keys, and this file
// imports nothing from them, so the split stays cycle-free (import-x/no-cycle).
export const githubKeys = {
  all: ["github"] as const,

  viewer: () => [...githubKeys.all, "viewer"] as const,
  user: (username: string) => [...githubKeys.all, "user", username],

  orgMembership: (org: string) =>
    [...githubKeys.all, "org-membership", org] as const,

  // The authenticated viewer's OWN membership in an org (GET
  // /user/memberships/orgs/{org}) — distinct from `orgMembership` above (the
  // org-scoped membership read). Single-sourced here because both the read
  // (useGetOwnOrgMembership) and the accept-invite invalidation key it.
  ownOrgMembership: (org: string | undefined) =>
    [...githubKeys.all, "memberships", "orgs", org] as const,

  orgRepos: (org: string) => [...githubKeys.all, "org-repos", org] as const,

  orgMembers: (org: string) => ["orgs", "list", "members", org] as const,

  // Distinct from `orgMembers` (page-1 via listOrgMembers): this keys the
  // all-pages fetch for the org Members page. Sharing one key would let the
  // page-1 and all-pages results overwrite each other in the cache.
  orgMembersAll: (org: string) =>
    ["orgs", "list", "members", "all", org] as const,

  orgAdmins: (org: string) =>
    ["orgs", "list", "members", "admins", org] as const,

  orgRunners: (org: string) => [...githubKeys.all, "org-runners", org] as const,

  teamMembers: (org: string, teamSlug: string) =>
    [...githubKeys.all, "team-members", org, teamSlug] as const,

  teamInvitations: (org: string, teamSlug: string) =>
    [...githubKeys.all, "team-invitations", org, teamSlug] as const,

  teamFailedInvitations: (org: string, teamSlug: string) =>
    [...githubKeys.all, "team-failed-invitations", org, teamSlug] as const,

  orgTeams: (org: string) => [...githubKeys.all, "org-teams", org] as const,

  myTeams: () => [...githubKeys.all, "my-teams"] as const,

  repo: (owner: string, repo: string) =>
    [...githubKeys.all, "repo", owner, repo] as const,

  collaborators: (org: string, repo: string) =>
    [...githubKeys.all, "collaborators", org, repo] as const,

  openPulls: (owner: string, repo: string) =>
    [...githubKeys.all, "open-pulls", owner, repo] as const,

  branchRef: (org: string) => [...githubKeys.all, "branchRef", org] as const,
  commitTree: (org: string, branchSha: string) =>
    [...githubKeys.all, "commitRef", org, branchSha] as const,

  configCommits: (org: string, perPage: number) =>
    [...githubKeys.all, "config-commits", org, perPage] as const,

  rawFile: (owner: string, repo: string, path: string, ref?: string) =>
    [...githubKeys.all, "raw-file", owner, repo, path, ref ?? null] as const,

  // Distinct from `rawFile`: the roster raw read uses a different queryFn (with
  // a 404 fallback from the current roster name to the legacy one), so it must
  // not share a cache entry with rawFileQuery for the same path.
  rosterRawFile: (owner: string, repo: string, path: string, ref?: string) =>
    [
      ...githubKeys.all,
      "roster-raw-file",
      owner,
      repo,
      path,
      ref ?? null,
    ] as const,

  jsonFile: (owner: string, repo: string, path?: string, ref?: string) =>
    [
      ...githubKeys.all,
      "json-file",
      owner,
      repo,
      path || "",
      ref ?? null,
    ] as const,

  csvFile: (owner: string, repo: string, path: string, ref?: string) =>
    [...githubKeys.all, "csv-file", owner, repo, path, ref ?? null] as const,

  collectScoresRun: (owner: string, sinceRunId: number | null) =>
    [
      ...githubKeys.all,
      "collect-scores-run",
      owner,
      sinceRunId ?? "none",
    ] as const,

  lastCollectScoresRun: (owner: string) =>
    [...githubKeys.all, "last-collect-scores-run", owner] as const,

  // Scoped by classroom + assignment (+ optional repo owner) so a regrade of
  // one assignment doesn't surface as in-progress on another assignment's
  // page; sinceRunId binds the poll to our specific dispatch.
  regradeRun: (
    owner: string,
    classroom: string,
    assignment: string,
    repoOwner: string | null,
    sinceRunId: number | null,
  ) =>
    [
      ...githubKeys.all,
      "regrade-run",
      owner,
      classroom,
      assignment,
      repoOwner ?? "all",
      sinceRunId ?? "none",
    ] as const,

  serviceToken: (owner: string) =>
    [...githubKeys.all, "serviceToken", owner] as const,

  skeletonDrift: (owner: string) =>
    [...githubKeys.all, "skeletonDrift", owner] as const,

  orgAudit: (owner: string, plan?: string) =>
    [...githubKeys.all, "orgAudit", owner, plan ?? null] as const,

  // Prefix matching every orgAudit entry for an org regardless of plan — use
  // for invalidation so a refetch happens whatever plan the cached audit used.
  orgAuditPrefix: (owner: string) =>
    [...githubKeys.all, "orgAudit", owner] as const,

  releases: (owner: string, repo: string) =>
    [...githubKeys.all, "releases", owner, repo] as const,
}

// Refresh roster invite-status lists after enroll/resend/unenroll: invites move
// between pending/failed/members. Team-scoped caches are keyed by slug, so
// invalidate by the [.., kind, org] prefix to cover every classroom team.
export function invalidateInviteQueries(queryClient: QueryClient, org: string) {
  queryClient.invalidateQueries({
    queryKey: [...githubKeys.all, "team-invitations", org],
  })
  queryClient.invalidateQueries({
    queryKey: [...githubKeys.all, "team-failed-invitations", org],
  })
  queryClient.invalidateQueries({ queryKey: githubKeys.orgMembers(org) })
}
