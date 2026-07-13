import { queryOptions } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import Papa from "papaparse"

import type { GitHubClient } from "./client"
import type {
  GitHubBranchRef,
  GitHubCommit,
  GitHubCommitRef,
  GitHubFileListing,
  GitHubOrgInvitation,
  GitHubOrgMembership,
  GitHubRelease,
  GitHubRepo,
  GitHubTeam,
  GitHubUser,
  GitHubWorkflowRun,
} from "./types"
import type { Assignment } from "@/types/classroom"
import { CONFIG_REPO_MARKER_REL, ORG_GITHUB_DIR } from "@/skeleton/skeleton"
import { GitHubAPIError, retryTransientGitHubError } from "./errors"
import {
  COLLECT_SCORES_WORKFLOW,
  REGRADE_WORKFLOW,
  createTeam,
  getErrorMessage,
  type GitHubTreeResponse,
} from "./mutations"
import { decodeBase64Utf8 } from "@/util/github"
import { mapWithConcurrency } from "@/util/concurrency"
import { getCommit } from "@/api/github/queries"
import { classroomPagesSegment } from "@/util/secret"
import type { GetAssignmentsFileInput } from "@/api/queries/assignments"
import type { OrgRunner, OrgRunnersResult } from "@/util/runners"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_QUERIES } from "@/lib/logScopes"

const log = logger.scope(LOG_SCOPE_QUERIES)

export const githubKeys = {
  all: ["github"] as const,

  viewer: () => [...githubKeys.all, "viewer"] as const,
  user: (username: string) => [...githubKeys.all, "user", username],

  orgMembership: (org: string) =>
    [...githubKeys.all, "org-membership", org] as const,

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

export function viewerQuery(client: GitHubClient) {
  return queryOptions({
    queryKey: githubKeys.viewer(),
    queryFn: ({ signal }) =>
      client.request<GitHubUser>("/user", { method: "GET", signal }),
    staleTime: 10 * 60 * 1000,
  })
}

export function getUser(client: GitHubClient, username: string) {
  return client.request<GitHubUser>(`/users/${encodeURIComponent(username)}`)
}

// Resolve a user by their immutable numeric account id (GET /user/{id}). The
// stored CSV username goes stale if the student renames their GitHub account,
// but the id never changes — so this returns their CURRENT login. Used when
// re-inviting a roster student whose username may have drifted.
export function getUserById(client: GitHubClient, id: number | string) {
  return client.request<GitHubUser>(`/user/${encodeURIComponent(String(id))}`)
}

export function getUserQuery(client: GitHubClient, username: string) {
  return queryOptions({
    queryKey: githubKeys.user(username),
    queryFn: ({ signal }) =>
      client.request<GitHubUser>(`/users/${encodeURIComponent(username)}`, {
        method: "GET",
        signal,
      }),
    staleTime: 10 * 60 * 1000,
  })
}

export function orgMembershipQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.orgMembership(org),
    queryFn: ({ signal }) =>
      client.request<GitHubOrgMembership>(
        `/user/memberships/orgs/${encodeURIComponent(org)}`,
        { method: "GET", signal },
      ),
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// Self-hosted runners registered in the org (GitHub's admin:org endpoint), used
// only to advise whether a typed label exists. Tolerant: 403/404 resolve to an
// "unavailable" sentinel so the form degrades to "couldn't verify" instead of
// erroring. GitHub-hosted labels are recognized separately.
export function orgRunnersQuery(client: GitHubClient, org: string) {
  return queryOptions<OrgRunnersResult>({
    queryKey: githubKeys.orgRunners(org),
    queryFn: async ({ signal }) => {
      try {
        const runners: OrgRunner[] = []
        let page = 1

        while (true) {
          const data = await client.request<{
            total_count: number
            runners: OrgRunner[]
          }>(
            `/orgs/${encodeURIComponent(
              org,
            )}/actions/runners?per_page=100&page=${page}`,
            { method: "GET", signal },
          )

          const batch = data.runners ?? []
          runners.push(...batch)

          if (batch.length < 100) break
          page++
        }

        return { available: true, runners }
      } catch (error) {
        // Let cancellations propagate; don't cache them as a verdict.
        if (signal?.aborted) throw error
        // 403 (no admin:org) / 404 (no access) mean "can't read the list",
        // not "the runner doesn't exist".
        if (
          error instanceof GitHubAPIError &&
          (error.status === 403 || error.status === 404)
        ) {
          return { available: false, reason: "no-access" }
        }
        return { available: false, reason: "error" }
      }
    },
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function getBranchRefRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
) {
  return client.request<GitHubBranchRef>(
    `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
  )
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isGitRepositoryEmptyError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("git repository is empty")
  )
}

function isNotFoundError(error: unknown) {
  return (
    error instanceof Error && error.message.toLowerCase().includes("not found")
  )
}

// A freshly-generated repo's git-data APIs lag the 200 from POST .../generate:
// reads 404 and the first write 409s "Git Repository is empty" while GitHub
// seeds. A bare 409 (no empty-repo message) is a real conflict (e.g.
// non-fast-forward updateRef), so the 409 branch is gated on the message.
export function isFreshRepoLagError(error: unknown) {
  if (error instanceof GitHubAPIError) {
    if (error.status === 404) {
      return true
    }
    if (error.status === 409) {
      return isGitRepositoryEmptyError(error)
    }
  }
  return isGitRepositoryEmptyError(error) || isNotFoundError(error)
}

export type FreshRepoRetryOptions = {
  attempts?: number
  baseDelayMs?: number
  // Backoff multiplier between retries. 1 = fixed delay. Default 2.
  backoffFactor?: number
  // Which errors count as retryable lag. Default isFreshRepoLagError.
  shouldRetry?: (error: unknown) => boolean
}

// Retry `fn` while it hits fresh-repo lag. `fn` must re-read its own state each
// attempt and may throw a synthetic error to signal non-HTTP lag (e.g. a 200
// with a blank SHA).
export async function withFreshRepoRetry<T>(
  fn: () => Promise<T>,
  options: FreshRepoRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 6
  const baseDelayMs = options.baseDelayMs ?? 500
  const backoffFactor = options.backoffFactor ?? 2
  const shouldRetry = options.shouldRetry ?? isFreshRepoLagError

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!shouldRetry(err) || attempt === attempts) {
        throw err
      }
      log.debug("fresh-repo lag, retrying read", { attempt })
      await sleep(baseDelayMs * backoffFactor ** (attempt - 1))
    }
  }

  throw lastError
}

export function branchRefQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.branchRef(org),
    queryFn: ({ signal }) =>
      client.request<GitHubBranchRef>(
        `/repos/${org}/classroom50/git/ref/heads/main`,
        { method: "GET", signal },
      ),
    enabled: Boolean(org),
    staleTime: 60 * 1000,
    retry: false,
  })
}

export function getCommitByRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
) {
  return client.request<GitHubCommitRef>(
    `/repos/${owner}/${repo}/git/commits/${branch}`,
  )
}
export function commitQuery(
  client: GitHubClient,
  org: string,
  branchSha: string,
) {
  return queryOptions({
    queryKey: githubKeys.commitTree(org, branchSha),
    queryFn: ({ signal }) =>
      client.request<GitHubCommitRef>(
        `/repos/${org}/classroom50/git/commits/${branchSha}`,
        { method: "GET", signal },
      ),
    enabled: Boolean(org && branchSha),
    staleTime: 60 * 1000,
    retry: false,
  })
}

export function repoQuery(client: GitHubClient, owner: string, repo: string) {
  return queryOptions({
    queryKey: githubKeys.repo(owner, repo),
    queryFn: ({ signal }) =>
      client.request<GitHubRepo>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { method: "GET", signal },
      ),
    enabled: Boolean(owner && repo),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export function rawFileQuery(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
) {
  const params = new URLSearchParams()

  if (ref) {
    params.set("ref", ref)
  }

  const suffix = params.size ? `?${params.toString()}` : ""

  return queryOptions({
    queryKey: githubKeys.rawFile(owner, repo, path, ref),
    queryFn: ({ signal }) =>
      client.requestRaw(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repo,
        )}/contents/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}${suffix}`,
        { method: "GET", signal },
      ),
    enabled: Boolean(owner && repo && typeof path === "string"),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

export function jsonFileQuery<T>(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
) {
  return queryOptions({
    queryKey: githubKeys.jsonFile(owner, repo, path, ref),
    queryFn: async ({ signal }) => {
      const raw = await client.requestRaw(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
          repo,
        )}/contents/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
        { method: "GET", signal },
      )

      // Throw a friendly error naming the file rather than a raw SyntaxError.
      try {
        return JSON.parse(raw) as T
      } catch {
        throw new Error(
          `${path} couldn't be read (the file may be malformed). Try refreshing in a moment.`,
        )
      }
    },
    enabled: Boolean(owner && repo && typeof path === "string"),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

// The submission-tag convention written by the autograde runner: each graded
// push publishes a `submit/<timestamp>-<sha>` release whose body GitHub renders
// as the score + per-test table. We list these and link students straight to
// the release page rather than reading result.json.
const SUBMISSION_TAG_PREFIX = "submit/"

// All graded-submission releases for a student's repo, newest first. A repo
// with no releases yet (or a first push still grading) returns []. The release
// page shows the rendered grade, so we only need the metadata.
export function releasesQuery(
  client: GitHubClient,
  owner: string,
  repo: string,
) {
  return queryOptions({
    queryKey: githubKeys.releases(owner, repo),
    queryFn: async ({ signal }): Promise<GitHubRelease[]> => {
      try {
        const releases = await client.request<GitHubRelease[]>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
            repo,
          )}/releases?per_page=100`,
          { method: "GET", signal },
        )

        return releases
          .filter((r) => r.tag_name.startsWith(SUBMISSION_TAG_PREFIX))
          .sort((a, b) => releaseTime(b) - releaseTime(a))
      } catch (err) {
        // A missing repo (student hasn't accepted, or a previewing teacher with
        // no repo) 404s here — no releases. Return [] so the page falls through
        // to its empty state. Other errors throw.
        if (err instanceof GitHubAPIError && err.status === 404) {
          return []
        }
        throw err
      }
    },
    enabled: Boolean(owner && repo),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// The most-recent `perPage` commits of the classroom50 config-repo history,
// newest-first — the audit log behind the org Activity view. Each GUI write is a
// structured "[Classroom 50] <verb> <target>" commit (see util/commit.ts), so
// the messages read as an audit trail as-is. A window (not page) model so the
// Activity view's "Load older" just grows perPage and the single query holds the
// whole accumulated list. A missing/uninitialized repo 404s -> [] so a fresh org
// degrades to an empty section rather than an error.
export function configCommitsQuery(
  client: GitHubClient,
  org: string | undefined,
  perPage = 30,
) {
  return queryOptions({
    queryKey: githubKeys.configCommits(org ?? "", perPage),
    queryFn: async ({ signal }): Promise<GitHubCommit[]> => {
      try {
        return await client.request<GitHubCommit[]>(
          `/repos/${encodeURIComponent(
            org ?? "",
          )}/classroom50/commits?per_page=${perPage}`,
          { method: "GET", signal },
        )
      } catch (err) {
        if (err instanceof GitHubAPIError && err.status === 404) return []
        throw err
      }
    },
    enabled: Boolean(org),
    staleTime: 60 * 1000,
    retry: false,
  })
}

// published_at is null for a draft; fall back to created_at so ordering holds.
function releaseTime(release: GitHubRelease): number {
  return new Date(release.published_at ?? release.created_at).getTime()
}

export function csvFileQuery<T>(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
  // Legacy path tried only when `path` 404s (current roster name -> legacy).
  // The query key stays on `path`, so a post-migration read converges on the
  // current name and optimistic writes never have to know which name served the
  // bytes.
  fallbackPath?: string,
) {
  return queryOptions({
    queryKey: githubKeys.csvFile(owner, repo, path, ref),
    queryFn: async ({ signal }) => {
      let raw: string
      try {
        raw = await readContents(client, owner, repo, path, ref, signal)
      } catch (err) {
        if (
          fallbackPath &&
          err instanceof GitHubAPIError &&
          err.status === 404
        ) {
          raw = await readContents(
            client,
            owner,
            repo,
            fallbackPath,
            ref,
            signal,
          )
        } else {
          throw err
        }
      }

      const csvParse = Papa.parse<T>(raw, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header: string) => header.trim(),
        transform: (value: string) => value.trim(),
      })

      return csvParse.data
    },
    enabled: Boolean(owner && repo && typeof path === "string"),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

function readContents(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref: string | undefined,
  signal: AbortSignal | undefined,
) {
  return client.requestRaw(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
    { method: "GET", signal },
  )
}

// Raw roster.csv bytes with a legacy fallback (current roster name -> legacy on
// a 404), returning the unparsed text so the caller can run the strict parser
// and surface per-line problems. Keyed on `rosterRawFile` — a namespace of its
// own, distinct from both `rawFile` (rawFileQuery, no fallback, different
// queryFn) and csvFileQuery's parsed-rows key — so this additive
// problem-detection read can never collide with another raw or parsed read of
// the same path. The parsed-rows read (csvFileQuery) still drives display.
export function rosterRawFileQuery(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  fallbackPath?: string,
  ref?: string,
) {
  return queryOptions({
    queryKey: githubKeys.rosterRawFile(owner, repo, path, ref),
    queryFn: async ({ signal }) => {
      try {
        return await readContents(client, owner, repo, path, ref, signal)
      } catch (err) {
        if (
          fallbackPath &&
          err instanceof GitHubAPIError &&
          err.status === 404
        ) {
          return await readContents(
            client,
            owner,
            repo,
            fallbackPath,
            ref,
            signal,
          )
        }
        throw err
      }
    },
    enabled: Boolean(owner && repo && typeof path === "string"),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}

export async function getRawFile(
  client: GitHubClient,
  input: GetAssignmentsFileInput,
): Promise<string> {
  const { org, path, ref } = input

  const file = await client.request<{
    type: "file"
    encoding: "base64"
    content: string
  }>(
    `/repos/${org}/classroom50/contents/${path}?ref=${encodeURIComponent(ref)}`,
  )

  if (file.type !== "file") {
    throw new Error(`${path} is not a file`)
  }

  return decodeBase64Utf8(file.content)
}

// Read a config file for a WRITE, reporting whether the returned bytes came
// from the legacy fallback path. Callers pass `fromLegacy` to rosterWriteTree,
// where it authorizes deleting the legacy file — so it must NOT be decided by a
// bare Contents-API 404: that API is eventually consistent per path, so right
// after a write to the current name a read pinned to that commit can briefly
// 404 while the legacy name still serves stale bytes. Trusting that 404 would
// overwrite the current file with stale legacy content and delete it on a clean
// fast-forward the conflict-retry loop can't catch — a silently lost write. So
// on a 404 we resolve legacy-vs-lag from the git TREE at the same commit
// (internally consistent, unlike per-path Contents reads). A non-404 error
// propagates unchanged.
export async function getRawFileWithFallbackSource(
  client: GitHubClient,
  input: GetAssignmentsFileInput & { fallbackPath: string },
): Promise<{ content: string; fromLegacy: boolean }> {
  const { fallbackPath, ...primary } = input
  try {
    return { content: await getRawFile(client, primary), fromLegacy: false }
  } catch (err) {
    if (!(err instanceof GitHubAPIError && err.status === 404)) throw err
    // Primary 404 — decide legacy-vs-lag from the commit tree, not the 404.
    if (
      await pathInCommitTree(client, primary.org, primary.path, primary.ref)
    ) {
      // Tree says the current name exists; the 404 was consistency lag. Re-read
      // it so a stale legacy read can't drive an overwrite + delete.
      return { content: await getRawFile(client, primary), fromLegacy: false }
    }
    return {
      content: await getRawFile(client, { ...primary, path: fallbackPath }),
      fromLegacy: true,
    }
  }
}

// True when `path` is a blob in the commit's recursive tree at `ref`. A
// truncated tree is treated as "not confirmed present" so the caller only takes
// the destructive legacy path when the tree positively lacks `path`.
async function pathInCommitTree(
  client: GitHubClient,
  org: string,
  path: string,
  ref: string,
): Promise<boolean> {
  const commit = await getCommit(client, org, ref)
  const tree = await client.request<GitHubTreeResponse>(
    `/repos/${org}/classroom50/git/trees/${commit.tree.sha}?recursive=1`,
  )
  if (tree.truncated) return false
  return tree.tree.some((e) => e.type === "blob" && e.path === path)
}

export async function getClassroom50Yaml(
  client: GitHubClient,
  org: string,
  repo: string,
): Promise<string> {
  const file = await client.request<{
    type: "file"
    encoding: "base64"
    content: string
  }>(`/repos/${org}/${repo}/contents/.classroom50.yaml?ref=main`)

  if (file.type !== "file") {
    throw new Error(`.classroom50.yaml not found in ${repo}`)
  }

  return decodeBase64Utf8(file.content)
}

export function listOrgMembers(client: GitHubClient, org: string, page = 1) {
  return client.request<GitHubUser[]>(
    `/orgs/${org}/members?per_page=100&page=${page}`,
  )
}

// Every org member across all pages. `listOrgMembers` (used by the per-classroom
// roster, where the first 100 is effectively always enough) fetches a single
// page; the org Members page needs the full list, so it pages to completion.
export function listAllOrgMembers(client: GitHubClient, org: string) {
  return paginateAll<GitHubUser>(
    client,
    (page) => `/orgs/${org}/members?per_page=100&page=${page}`,
  )
}

// The active org-member list (all pages) as a shared query. Single source for
// the `orgMembersAll` cache both the classroom roster (needs-attention
// in-org/not-in-org split) and the org Members page read, so the two can't
// drift on cache key, fetcher, or freshness. Kept short (30s): membership
// classification must react quickly to an invite accepted or a member removed
// in another tab/session, and the list is cheap to refetch. Since the two
// needs-attention states only affect a CSV-only row's sub-label (never
// enrollment, which is team-driven), a brief staleness is display-only.
export const ORG_MEMBERS_STALE_MS = 30 * 1000
export function orgMembersAllQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.orgMembersAll(org),
    queryFn: () => listAllOrgMembers(client, org),
    enabled: Boolean(org),
    staleTime: ORG_MEMBERS_STALE_MS,
  })
}

// Org owners/admins across all pages (GET /orgs/{org}/members?role=admin). Used
// to badge the Members page: an admin is an "Owner", not a "Member". 403/404
// (can't read the filtered member list) -> [] so the page degrades to treating
// everyone as a plain member rather than erroring.
export async function listOrgAdmins(
  client: GitHubClient,
  org: string,
): Promise<GitHubUser[]> {
  try {
    return await paginateAll<GitHubUser>(
      client,
      (page) =>
        `/orgs/${encodeURIComponent(org)}/members?role=admin&per_page=100&page=${page}`,
    )
  } catch (error) {
    if (
      error instanceof GitHubAPIError &&
      (error.status === 403 || error.status === 404)
    ) {
      return []
    }
    throw error
  }
}

export function orgAdminsQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.orgAdmins(org),
    queryFn: () => listOrgAdmins(client, org),
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
  })
}

// Server-side equivalent of useGetClasses: classroom dirs in the org's
// classroom50 repo (root contents, dirs minus .github), for non-hook callers.
export async function listClassroomDirs(
  client: GitHubClient,
  org: string,
  ref?: string,
): Promise<GitHubFileListing[]> {
  const raw = await client.requestRaw(
    `/repos/${encodeURIComponent(org)}/classroom50/contents/${
      ref ? `?ref=${encodeURIComponent(ref)}` : ""
    }`,
    { method: "GET" },
  )
  const listing = JSON.parse(raw) as GitHubFileListing[]
  return listing.filter(
    (entry) => entry.type === "dir" && entry.name !== ".github",
  )
}

// Walk a GitHub list endpoint to exhaustion, 100 items per page. `makePath`
// receives the 1-based page number. Stops when a page returns fewer than 100.
export async function paginateAll<T>(
  client: GitHubClient,
  makePath: (page: number) => string,
): Promise<T[]> {
  const all: T[] = []
  let page = 1
  // Hard cap (100 pages x 100/page = 10k items) so a server that ignores the
  // page param and keeps returning full pages can't loop unbounded.
  const MAX_PAGES = 100

  while (page <= MAX_PAGES) {
    const batch = await client.request<T[]>(makePath(page))
    all.push(...batch)
    if (batch.length < 100) break
    page++
  }

  if (page > MAX_PAGES) {
    log.warn("pagination hit MAX_PAGES cap, results may be truncated", {
      maxPages: MAX_PAGES,
    })
  }

  return all
}

// Failed / expired org invitations (carry failed_at / failed_reason). Owner-only.
// Read org-wide, then attributed to a classroom team by
// getOrgFailedInvitationsForTeam (GitHub has no team-scoped failed endpoint).
export async function getOrgFailedInvitations(
  client: GitHubClient,
  org: string,
): Promise<GitHubOrgInvitation[]> {
  return paginateAll<GitHubOrgInvitation>(
    client,
    (page) => `/orgs/${org}/failed_invitations?per_page=100&page=${page}`,
  )
}

// Failed org invitations scoped to ONE classroom team. GitHub has no
// team-scoped failed endpoint, so this reads the org-wide failed list and keeps
// only invites whose team set (resolved per invite from invitation_teams_url)
// includes `teamSlug`. A per-invite teams read that fails drops that invite, so
// one bad read never leaks an unattributable invite onto the roster. Owner-only.
export async function getOrgFailedInvitationsForTeam(
  client: GitHubClient,
  org: string,
  teamSlug: string,
): Promise<GitHubOrgInvitation[]> {
  const failed = await getOrgFailedInvitations(client, org)
  const wantSlug = teamSlug.toLowerCase()
  const candidates = failed.filter((inv) => (inv.team_count ?? 0) > 0)
  const onTeam = await mapWithConcurrency(
    candidates,
    REPO_READ_CONCURRENCY,
    async (inv) => {
      if (!inv.invitation_teams_url) return false
      try {
        const teams = await client.request<GitHubTeam[]>(
          inv.invitation_teams_url,
        )
        return teams.some((t) => t.slug?.toLowerCase() === wantSlug)
      } catch {
        return false
      }
    },
  )
  return candidates.filter((_, i) => onTeam[i])
}

export async function getTeam(
  client: GitHubClient,
  org: string,
  classroom: string,
) {
  const teamSlug = `classroom50-${classroom}`

  try {
    return await client.request<GitHubTeam>(`/orgs/${org}/teams/${teamSlug}`)
  } catch (error) {
    if (error instanceof GitHubAPIError && error.status === 404) {
      return null
    }

    throw error
  }
}

// Whether the classroom team already has access to a repo (the in-org private
// template). 2xx = has access, 404 = doesn't; other errors propagate so a
// transient failure isn't misread as "no access".
export async function teamHasRepoAccess(
  client: GitHubClient,
  input: { org: string; classroom: string; owner: string; repo: string },
): Promise<boolean> {
  const { org, classroom, owner, repo } = input
  const teamSlug = `classroom50-${classroom}`

  try {
    await client.request(
      `/orgs/${org}/teams/${teamSlug}/repos/${owner}/${repo}`,
    )
    return true
  } catch (error) {
    if (error instanceof GitHubAPIError && error.status === 404) {
      return false
    }
    throw error
  }
}

export async function ensureTeam(
  client: GitHubClient,
  org: string,
  classroom: string,
): Promise<GitHubTeam> {
  const existingTeam = await getTeam(client, org, classroom)

  if (existingTeam) return existingTeam

  try {
    return await createTeam(client, { org, name: `classroom50-${classroom}` })
  } catch (error) {
    if (error instanceof GitHubAPIError && error.status === 422) {
      const team = await getTeam(client, org, classroom)

      if (team) return team
    }

    throw error
  }
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
  })

  if (response.status === 404) {
    throw new Error(
      "The classroom may not exist yet, or publish-pages.yaml may not have run.",
    )
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }

  return response.json() as Promise<T>
}

export function pagesAssignmentUrl(
  org: string,
  classroom: string,
  secret?: string,
) {
  const segment = classroomPagesSegment(classroom, secret)
  return `https://${org}.github.io/classroom50/${segment}/assignments.json`
}

// Public, unauthenticated signal that an org is a real Classroom50 org: the
// classroom50 Pages site publishes this index, so a student who can't read the
// private config repo can still distinguish a genuine Classroom50 org.
export function classroomsIndexUrl(org: string) {
  return `https://${org}.github.io/classroom50/classrooms-index.json`
}

export async function orgPublishesClassroom50Pages(
  org: string,
): Promise<"yes" | "no" | "indeterminate"> {
  try {
    const res = await fetch(classroomsIndexUrl(org), {
      cache: "no-store",
      // Bound the probe so a hung github.io host can't stall the orgs load.
      signal: AbortSignal.timeout(5000),
    })
    // A clean 404 is a definitive "not a Classroom50 org". Other non-ok statuses
    // (5xx, 429) are transient -> indeterminate.
    if (res.status === 404) return "no"
    if (!res.ok) return "indeterminate"
    // Confirm it's actually the index shape, not a stray 200 (e.g. a custom 404
    // page served with 200).
    const data = (await res.json()) as { classrooms?: unknown }
    return Array.isArray(data?.classrooms) ? "yes" : "no"
  } catch (err) {
    log.warn("org Pages probe failed (indeterminate)", { org, err })
    // Network failure, timeout, DNS, CORS -> transient; never collapse to a
    // definitive "no" (that would hide a genuinely-enrolled student's org).
    return "indeterminate"
  }
}

export type AssignmentsJson =
  | Assignment[]
  | {
      version?: 1
      assignments: Assignment[]
    }
export function extractAssignments(json: AssignmentsJson): Assignment[] {
  if (Array.isArray(json)) return json

  if (json.version !== undefined && json.version !== 1) {
    throw new Error(
      `This classroom uses assignments.json v${json.version}, but this client only supports v1. Please update classroom50.`,
    )
  }

  if (!Array.isArray(json.assignments)) {
    throw new Error(
      "assignments.json has an invalid v1 shape. Ask your instructor to check classroom50 configuration.",
    )
  }

  return json.assignments
}

export async function fetchPagesAssignments(
  org: string,
  classroom: string,
  secret?: string,
): Promise<Assignment[]> {
  const json = await fetchJson<AssignmentsJson>(
    pagesAssignmentUrl(org, classroom, secret),
  )
  const assignments = extractAssignments(json)

  return assignments
}

export async function listAuthedOrgMemberships(client: GitHubClient) {
  return client.request<GitHubOrgMembership[]>(
    "/user/memberships/orgs?per_page=100",
  )
}

export async function getAuthedOrgMembership(
  client: GitHubClient,
  org: string,
) {
  return client.request<GitHubOrgMembership>(`/user/memberships/orgs/${org}`)
}

export type Classroom50OrgSummary = {
  org: {
    login: string
    id: number
    avatar_url: string
    description?: string | null
    html_url: string
  }

  membership: {
    state: "active" | "pending"
    role: "admin" | "member"
  }

  classroom50: {
    status: Classroom50Status
    canAccessRepo: boolean
    canInitialize: boolean
    pagesUrl: string
  }
}

type Classroom50Status =
  "ready" | "needs_setup" | "no_access" | "not_classroom50" | "unknown"

const CONFIG_REPO_MARKER_PATH = `${ORG_GITHUB_DIR}/${CONFIG_REPO_MARKER_REL}`

// True when a readable `classroom50` repo is a real config repo, not a name
// collision (an org owning an unrelated repo named `classroom50`, e.g. this
// project's own source). A clean 404 on the marker means collision; any other
// error is transient/permission, so fail open — hiding a real teacher's org
// behind a read blip is worse than briefly showing one extra.
export async function verifyClassroom50ConfigRepo(
  client: { request: (path: string) => Promise<unknown> },
  org: string,
): Promise<boolean> {
  try {
    await client.request(
      `/repos/${org}/classroom50/contents/${CONFIG_REPO_MARKER_PATH}`,
    )
    return true
  } catch (error) {
    if (error instanceof GitHubAPIError && error.status === 404) {
      return false
    }
    log.warn("config-repo marker read failed, failing open", { org, error })
    return true
  }
}

export async function getClassroom50OrgSummary(
  client: GitHubClient,
  membership: GitHubOrgMembership,
): Promise<Classroom50OrgSummary> {
  const org = membership.organization

  let canAccessRepo = false
  let status: Classroom50Status

  try {
    await client.request(`/repos/${org.login}/classroom50`)
    canAccessRepo = true

    const isConfigRepo = await verifyClassroom50ConfigRepo(client, org.login)
    status = isConfigRepo ? "ready" : "not_classroom50"

    // The service-token read is deliberately NOT done here: this summary runs
    // for every org the user can see, so reading the token per org fans out an
    // extra API call across many orgs. The token (and full policy audit) is
    // checked only when a specific org is opened (teacher preflight on
    // ClassesPage).
  } catch (error) {
    if (error instanceof GitHubAPIError && error.status === 404) {
      canAccessRepo = false

      if (membership.state === "active" && membership.role === "admin") {
        // An admin who can't see classroom50 hasn't initialized it yet.
        status = "needs_setup"
      } else {
        // A non-admin gets a 404 both when the org isn't a Classroom50 org and
        // when it is but the config repo is private to them. Disambiguate via
        // the public Pages index. On an indeterminate probe (transient network
        // failure) keep the org visible (no_access) rather than hiding a
        // genuinely-enrolled student's org behind a CDN blip.
        const pagesVerdict = await orgPublishesClassroom50Pages(org.login)
        status = pagesVerdict === "no" ? "not_classroom50" : "no_access"
      }
    } else {
      status = "unknown"
    }
  }

  return {
    org,
    membership: {
      state: membership.state,
      role: membership.role,
    },
    classroom50: {
      status,
      canAccessRepo,
      canInitialize:
        membership.state === "active" && membership.role === "admin",
      pagesUrl: `https://${org.login}.github.io/classroom50/`,
    },
  }
}

// Max simultaneous per-repo reads. Bounded so a large class doesn't fan out
// into hundreds of concurrent requests (GitHub secondary-rate-limit territory)
// while still beating a strictly-sequential loop.
export const REPO_READ_CONCURRENCY = 8

export async function getRepo(
  client: GitHubClient,
  owner: string,
  repo: string,
) {
  try {
    return await client.request<GitHubRepo>(`/repos/${owner}/${repo}`)
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      return null
    }
    throw err
  }
}

// List a team's members across all pages. 404 (team doesn't exist yet) returns
// [] so a classroom whose staff team hasn't been created reads as "no members".
export async function listTeamMembers(
  client: GitHubClient,
  org: string,
  teamSlug: string,
): Promise<GitHubUser[]> {
  try {
    return await paginateAll<GitHubUser>(
      client,
      (page) =>
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
          teamSlug,
        )}/members?per_page=100&page=${page}`,
    )
  } catch (error) {
    if (error instanceof GitHubAPIError && error.status === 404) return []
    throw error
  }
}

export function teamMembersQuery(
  client: GitHubClient,
  org: string,
  teamSlug: string,
) {
  return queryOptions({
    queryKey: githubKeys.teamMembers(org, teamSlug),
    queryFn: () => listTeamMembers(client, org, teamSlug),
    enabled: Boolean(org && teamSlug),
    staleTime: 60 * 1000,
  })
}

// List a team's pending invitations across all pages (GET
// /orgs/{org}/teams/{slug}/invitations). Unlike org-level invitations, these are
// team-scoped, so a pending invite can be attributed to the classroom role whose
// team lists it. 404 (team not created yet) -> [] like listTeamMembers; 403
// (owner-only) propagates so callers can hide pending. `login` is null for an
// email-only invitee (tag by email then).
export async function listTeamInvitations(
  client: GitHubClient,
  org: string,
  teamSlug: string,
): Promise<GitHubOrgInvitation[]> {
  try {
    return await paginateAll<GitHubOrgInvitation>(
      client,
      (page) =>
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
          teamSlug,
        )}/invitations?per_page=100&page=${page}`,
    )
  } catch (error) {
    if (error instanceof GitHubAPIError && error.status === 404) return []
    throw error
  }
}

export function teamInvitationsQuery(
  client: GitHubClient,
  org: string,
  teamSlug: string,
) {
  return queryOptions({
    queryKey: githubKeys.teamInvitations(org, teamSlug),
    queryFn: () => listTeamInvitations(client, org, teamSlug),
    enabled: Boolean(org && teamSlug),
    staleTime: 60 * 1000,
    // 403 (owner-only) / 404 stay definitive so pendingHidden / [] resolve at
    // once; a transient 5xx/429 self-heals rather than silently rendering zero
    // pending for the role with no retry (the query error isn't in isError).
    retry: retryTransientGitHubError,
  })
}

// Failed org invitations scoped to a classroom team. Owner-only, like the
// pending read; a transient 5xx self-heals. Attributes each org-wide failed
// invite to a team via its invitation_teams_url (see
// getOrgFailedInvitationsForTeam), so a failed invite for another classroom
// never surfaces on this roster.
export function teamFailedInvitationsQuery(
  client: GitHubClient,
  org: string,
  teamSlug: string,
) {
  return queryOptions({
    queryKey: githubKeys.teamFailedInvitations(org, teamSlug),
    queryFn: () => getOrgFailedInvitationsForTeam(client, org, teamSlug),
    enabled: Boolean(org && teamSlug),
    staleTime: 60 * 1000,
    retry: retryTransientGitHubError,
  })
}

// Every team in the org across all pages (GET /orgs/{org}/teams). Owner/member
// visibility applies (secret teams only listed for members who can see them).
// Used to cross-reference each `classroom50-<classroom>` team's live membership
// against CSV-derived classroom access, surfacing drift on the Members page.
// 404 (no access) -> [] so the page degrades to CSV-only display.
export async function listOrgTeams(
  client: GitHubClient,
  org: string,
): Promise<GitHubTeam[]> {
  try {
    return await paginateAll<GitHubTeam>(
      client,
      (page) =>
        `/orgs/${encodeURIComponent(org)}/teams?per_page=100&page=${page}`,
    )
  } catch (error) {
    if (error instanceof GitHubAPIError && error.status === 404) return []
    throw error
  }
}

export function orgTeamsQuery(client: GitHubClient, org: string) {
  return queryOptions({
    queryKey: githubKeys.orgTeams(org),
    queryFn: () => listOrgTeams(client, org),
    enabled: Boolean(org),
    staleTime: 5 * 60 * 1000,
  })
}

export type GitHubPullRequest = {
  number: number
  html_url: string
  state: "open" | "closed"
  title: string
  draft?: boolean
  head: { ref: string }
  base: { ref: string }
}

// Open PRs on a student/group repo. The autograde workflow opens one Feedback
// PR per repo, so the first open PR is that PR. 404 (repo not generated yet) ->
// []. Tolerant so a missing repo reads as "no PR" rather than throwing.
export async function getOpenPullRequests(
  client: GitHubClient,
  owner: string,
  repo: string,
  signal?: AbortSignal,
) {
  try {
    return await client.request<GitHubPullRequest[]>(
      `/repos/${owner}/${repo}/pulls?state=open&per_page=10`,
      { method: "GET", signal },
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      return []
    }
    throw err
  }
}

export async function getOrgRepos(client: GitHubClient, owner: string) {
  try {
    // Paginate to exhaustion: a single per_page=100 page silently under-counts
    // orgs with >100 repos, making repo-list-derived signals (e.g. assignment
    // acceptance on the submissions dashboard) miss students in large orgs. A
    // first-page failure still surfaces a 404 as null below.
    return await paginateAll<GitHubRepo>(
      client,
      (page) => `/orgs/${owner}/repos?per_page=100&page=${page}&type=all`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 404) {
      return null
    }
    throw err
  }
}

type RepositorySecret = {
  name: string
  created_at: string
  updated_at: string
}
const SERVICE_TOKEN_SECRET_NAME = "CLASSROOM50_SERVICE_TOKEN"
export type ServiceTokenStatus =
  | {
      status: "present"
      secretName: typeof SERVICE_TOKEN_SECRET_NAME
      createdAt: string
      updatedAt: string
      message: string
    }
  | {
      status: "missing"
      secretName: typeof SERVICE_TOKEN_SECRET_NAME
      message: string
    }
  | {
      status: "unknown"
      secretName: typeof SERVICE_TOKEN_SECRET_NAME
      reason: "repo_missing_or_no_access" | "permission_denied" | "unknown"
      message: string
    }

export async function getServiceTokenStatus(
  client: GitHubClient,
  org: string,
): Promise<ServiceTokenStatus> {
  try {
    const secret = await client.request<RepositorySecret>(
      `/repos/${org}/classroom50/actions/secrets/${SERVICE_TOKEN_SECRET_NAME}`,
    )

    return {
      status: "present",
      secretName: SERVICE_TOKEN_SECRET_NAME,
      createdAt: secret.created_at,
      updatedAt: secret.updated_at,
      message: `Service token is set on the classroom50 config repo. Last updated ${new Date(
        secret.updated_at,
      ).toLocaleString()}.`,
    }
  } catch (err) {
    if (err instanceof GitHubAPIError) {
      if (err.status === 404) {
        return {
          status: "missing",
          secretName: SERVICE_TOKEN_SECRET_NAME,
          message:
            "Service token is not set on the classroom50 config repo. Score-collection and regrade workflows cannot access student repositories until a service token is set.",
        }
      }

      if (err.status === 403) {
        return {
          status: "unknown",
          secretName: SERVICE_TOKEN_SECRET_NAME,
          reason: "permission_denied",
          message:
            "Could not check the service token on the classroom50 config repo because this GitHub authorization cannot read repository Actions secrets.",
        }
      }
    }

    return {
      status: "unknown",
      secretName: SERVICE_TOKEN_SECRET_NAME,
      reason: "unknown",
      message: `Could not check the service token on the classroom50 config repo: ${getErrorMessage(
        err,
      )}`,
    }
  }
}

export async function getRepoPermissionForUser(params: {
  client: GitHubClient
  org: string
  repo: string
  username: string
}): Promise<{ permission?: string; role_name?: string }> {
  const { client, org, repo, username } = params

  return client.request<{ permission?: string; role_name?: string }>(
    `/repos/${org}/${repo}/collaborators/${username}/permission`,
  )
}

// Fetches the most recent workflow run matching the given filters (or null) from
// a classroom50 workflow. Shared by the collect-scores "track my dispatch" /
// "last collected" reads and the regrade dispatch tracker, so the workflow file
// is a parameter (defaults to collect-scores).
async function listLatestWorkflowRun(
  client: GitHubClient,
  org: string,
  filters: {
    event?: string
    since?: string
    status?: string
    perPage?: number
    page?: number
  },
  signal?: AbortSignal,
  workflow: string = COLLECT_SCORES_WORKFLOW,
): Promise<GitHubWorkflowRun[]> {
  const params = new URLSearchParams({
    per_page: String(filters.perPage ?? 1),
  })
  if (filters.event) params.set("event", filters.event)
  if (filters.since) params.set("created", `>=${filters.since}`)
  if (filters.status) params.set("status", filters.status)
  if (filters.page) params.set("page", String(filters.page))

  const res = await client.request<{ workflow_runs: GitHubWorkflowRun[] }>(
    `/repos/${org}/classroom50/actions/workflows/${workflow}/runs?${params.toString()}`,
    { method: "GET", signal },
  )

  return res.workflow_runs ?? []
}

// Finds the run we dispatched: run ids are monotonic, so it's the oldest
// dispatch run with an id greater than `sinceRunId` (the newest id before our
// POST). Binding to our own run avoids mistaking a concurrent dispatch for ours
// and needs no clock. Null until our run registers; `sinceRunId === null` means
// no prior runs, so the oldest run on the first page is ours.
export async function getCollectScoresRunAfterId(
  client: GitHubClient,
  org: string,
  sinceRunId: number | null,
  signal?: AbortSignal,
): Promise<GitHubWorkflowRun | null> {
  const runs = await listLatestWorkflowRun(
    client,
    org,
    { event: "workflow_dispatch", perPage: 20 },
    signal,
  )

  // runs come newest-first; the run we triggered is the oldest one newer than
  // the pre-dispatch baseline.
  const newer =
    sinceRunId === null ? runs : runs.filter((r) => r.id > sinceRunId)
  return newer.length > 0 ? newer[newer.length - 1] : null
}

// Finds the regrade run we dispatched, by the same monotonic-id binding as
// getCollectScoresRunAfterId but against regrade.yaml. Null until our run
// registers.
//
// Unlike collect (one org-wide dispatcher), regrade can fan out one dispatch per
// student via the per-row buttons, so far more than a page of dispatch runs can
// pile up between our snapshot and this poll. A fixed first page would let our
// own run scroll off and bind us to a later student's run. So we page
// newest-first, accumulating only runs with id > sinceRunId, and stop once a
// page contains a run at/below the baseline (everything older is irrelevant) or
// we hit the page cap. The bound run is the oldest such run.
const REGRADE_RUNS_PER_PAGE = 30
const REGRADE_MAX_PAGES = 10

export async function getRegradeRunAfterId(
  client: GitHubClient,
  org: string,
  sinceRunId: number | null,
  signal?: AbortSignal,
): Promise<GitHubWorkflowRun | null> {
  // No prior runs: our run is the oldest dispatch run that exists, so a single
  // newest-first page is enough — the last entry is the earliest run.
  if (sinceRunId === null) {
    const runs = await listLatestWorkflowRun(
      client,
      org,
      { event: "workflow_dispatch", perPage: REGRADE_RUNS_PER_PAGE },
      signal,
      REGRADE_WORKFLOW,
    )
    return runs.length > 0 ? runs[runs.length - 1] : null
  }

  // Page through dispatch runs (newest-first) collecting those newer than the
  // baseline. Stop once a page reaches the baseline or yields nothing.
  const newer: GitHubWorkflowRun[] = []
  for (let page = 1; page <= REGRADE_MAX_PAGES; page++) {
    const runs = await listLatestWorkflowRun(
      client,
      org,
      { event: "workflow_dispatch", perPage: REGRADE_RUNS_PER_PAGE, page },
      signal,
      REGRADE_WORKFLOW,
    )
    if (runs.length === 0) break

    for (const r of runs) {
      if (r.id > sinceRunId) newer.push(r)
    }

    // This page already includes the baseline (or older), so no later page can
    // hold a run newer than it — we've seen every candidate.
    if (runs.some((r) => r.id <= sinceRunId)) break
  }

  // The run we triggered is the oldest one newer than the baseline.
  return newer.length > 0 ? newer[newer.length - 1] : null
}

// The most recent *completed* collect-scores run (cron or manual), or null if
// the workflow has never completed. Used for the "last collected" timestamp;
// status=completed stops an in-flight newer run from hiding the prior one.
export async function getLastCollectScoresRun(
  client: GitHubClient,
  org: string,
  signal?: AbortSignal,
): Promise<GitHubWorkflowRun | null> {
  const runs = await listLatestWorkflowRun(
    client,
    org,
    { status: "completed" },
    signal,
  )
  return runs[0] ?? null
}
