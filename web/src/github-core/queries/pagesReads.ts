import type { GitHubClient } from "../client"
import type { GitHubOrgMembership } from "../types"
import type { Assignment } from "@/types/classroom"
import { CONFIG_REPO_MARKER_REL, ORG_GITHUB_DIR } from "@/skeleton/skeleton"
import { CONFIG_REPO } from "@/util/configRepo"
import { GitHubAPIError } from "../errors"
import { classroomPagesSegment } from "@/util/secret"
import { log } from "./shared"
import { localizedError, localizedMessageOf } from "@/types/localizedMessage"

export async function fetchJson<T>(
  url: string,
  timeoutMs?: number,
): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  })

  if (response.status === 404) {
    throw localizedError({ key: "pagesErrors.classroomNotPublished" })
  }

  if (!response.ok) {
    throw localizedError({
      key: "pagesErrors.classroomFetchFailed",
      params: { status: response.status },
    })
  }

  return response.json() as Promise<T>
}

// The github.io base every published resource lives under by default.
// An org with a custom Pages domain overrides it per classroom via
// classroom.json's `pages_base_url` (see fetchPagesAssignments).
export function defaultPagesBaseUrl(org: string) {
  return `https://${org}.github.io/${CONFIG_REPO}`
}

export function pagesAssignmentUrl(
  org: string,
  classroom: string,
  secret?: string,
  // Normalized custom base (classroom.json / team-description
  // `pages_base_url`); absent = the github.io default.
  pagesBaseUrl?: string,
) {
  const segment = classroomPagesSegment(classroom, secret)
  return `${pagesBaseUrl || defaultPagesBaseUrl(org)}/${segment}/assignments.json`
}

// Public, unauthenticated signal that an org is a real Classroom50 org: the
// classroom50 Pages site publishes this index, so a student who can't read the
// private config repo can still distinguish a genuine Classroom50 org.
export function classroomsIndexUrl(org: string) {
  return `https://${org}.github.io/${CONFIG_REPO}/classrooms-index.json`
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
    // Confirm it's actually the index shape, not a stray 200 (e.g., a custom 404
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
    throw localizedError({
      key: "pagesErrors.manifestVersionUnsupported",
      params: { version: String(json.version) },
    })
  }

  if (!Array.isArray(json.assignments)) {
    throw localizedError({ key: "pagesErrors.manifestInvalidShape" })
  }

  return json.assignments
}

// One attempt against one host: fetch + shape-check. A bare fetch failure
// (network, DNS, a CORS-blocked redirect, or the custom-host timeout — the
// browser hides which) is named here so the view never renders a raw
// "Failed to fetch". `networkErrorKey` lets the custom-host attempt carry
// custom-domain-specific remediation copy.
async function fetchAssignmentsManifest(
  url: string,
  opts?: { timeoutMs?: number; networkErrorKey?: string },
): Promise<Assignment[]> {
  let json: AssignmentsJson
  try {
    json = await fetchJson<AssignmentsJson>(url, opts?.timeoutMs)
  } catch (err) {
    if (localizedMessageOf(err)) throw err
    throw localizedError({
      key: opts?.networkErrorKey ?? "pagesErrors.classroomNetworkFailed",
    })
  }
  return extractAssignments(json)
}

// Bound the custom-host attempt: a black-holing teacher-typed domain must not
// stall every student read behind the browser's multi-minute default timeout.
// Matches the 5s bound orgPublishesClassroom50Pages already uses; the
// github.io attempt stays unbounded (a known-good host, and the last resort).
export const CUSTOM_HOST_TIMEOUT_MS = 5000

// The URL(s) a published-resource read attempts, in order: the custom base
// first when one is set, then the github.io default — deduped when they
// coincide. The single source for the fallback order AND every "tried to
// load" error surface (the accept page renders this list), so the two can't
// drift. `relPath` is the path below the Pages base (no leading slash).
export function attemptedPagesUrls(
  org: string,
  relPath: string,
  pagesBaseUrl?: string,
): string[] {
  const defaultUrl = `${defaultPagesBaseUrl(org)}/${relPath}`
  const customUrl = pagesBaseUrl ? `${pagesBaseUrl}/${relPath}` : undefined
  return customUrl && customUrl !== defaultUrl
    ? [customUrl, defaultUrl]
    : [defaultUrl]
}

export function attemptedPagesAssignmentUrls(
  org: string,
  classroom: string,
  secret?: string,
  pagesBaseUrl?: string,
): string[] {
  return attemptedPagesUrls(
    org,
    `${classroomPagesSegment(classroom, secret)}/assignments.json`,
    pagesBaseUrl,
  )
}

export async function fetchPagesAssignments(
  org: string,
  classroom: string,
  secret?: string,
  pagesBaseUrl?: string,
): Promise<Assignment[]> {
  const urls = attemptedPagesAssignmentUrls(
    org,
    classroom,
    secret,
    pagesBaseUrl,
  )

  if (urls.length === 1) {
    return fetchAssignmentsManifest(urls[0])
  }

  // Custom Pages domain first — github.io answers such an org with a 301 the
  // browser's CORS check rejects (issue #776). Fall back to the default host
  // so a stale/wrong custom domain can't lock students out of a working
  // github.io site. Both failing throws a combined error naming both URLs,
  // with the CUSTOM host's failure as the detail: it is the org's intended
  // source, so its error is the actionable one — the default host's failure is
  // usually just the CORS-doomed 301 this feature exists to bypass.
  const [customUrl, defaultUrl] = urls
  let customErr: unknown
  try {
    return await fetchAssignmentsManifest(customUrl, {
      timeoutMs: CUSTOM_HOST_TIMEOUT_MS,
      networkErrorKey: "pagesErrors.customHostUnreachable",
    })
  } catch (err) {
    customErr = err
  }
  try {
    return await fetchAssignmentsManifest(defaultUrl)
  } catch {
    throw localizedError({
      key: "pagesErrors.classroomUnreachableBothHosts",
      params: {
        customUrl,
        defaultUrl,
        detail: localizedMessageOf(customErr) ?? {
          key: "pagesErrors.customHostUnreachable",
        },
      },
    })
  }
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
// collision (an org owning an unrelated repo named `classroom50`, e.g., this
// project's own source). A clean 404 on the marker means collision; any other
// error is transient/permission, so fail open — hiding a real teacher's org
// behind a read blip is worse than briefly showing one extra.
export async function verifyClassroom50ConfigRepo(
  client: { request: (path: string) => Promise<unknown> },
  org: string,
): Promise<boolean> {
  try {
    await client.request(
      `/repos/${org}/${CONFIG_REPO}/contents/${CONFIG_REPO_MARKER_PATH}`,
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

  // The one owner test for this summary: an active org admin. Single-sourced
  // here so the needs_setup branch and the canInitialize flag can't drift. This
  // is a github-core data-layer reducer on the raw wire payload, so the
  // wire-level `role === "admin"` check stays inline here (github-core is below
  // the authz module and must not import up into it; the product-facing owner
  // checks route through isOwnerGitHubOrgRole/can, this raw-payload one doesn't).
  const isActiveAdmin =
    membership.state === "active" && membership.role === "admin"

  let canAccessRepo = false
  let status: Classroom50Status

  try {
    await client.request(`/repos/${org.login}/${CONFIG_REPO}`)
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

      if (isActiveAdmin) {
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
      canInitialize: isActiveAdmin,
      pagesUrl: `https://${org.login}.github.io/${CONFIG_REPO}/`,
    },
  }
}
