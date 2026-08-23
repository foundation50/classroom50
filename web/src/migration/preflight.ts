// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Assembles the read-only plan the
// confirm screen renders and execute consumes: resolve source, derive/validate
// the short-name, classify every assignment, and run the two blocking
// preconditions (target org is a Classroom 50 org; short-name dir is free). No
// writes.

import type { GitHubClient } from "@/github-core/client"
import { GitHubAPIError } from "@/github-core/errors"
import { CONFIG_REPO } from "@/util/configRepo"
import { classifyAssignment } from "./classify"
import { fetchAssignmentsForClassroom, resolveSource } from "./classroomApi"
import { deriveShortName } from "./translate"
import { assertValidShortName } from "@/util/shortName"
import { CLASSROOM_SHORT_NAME_MAX_LEN } from "@/util/repoNameBudget"
import { localizedError } from "@/types/localizedMessage"
import type {
  MigrationBlocker,
  MigrationItem,
  MigrationPreflight,
} from "./types"

export type BuildPreflightInput = {
  // Numeric classroom id or source org login.
  source: string
  targetOrg: string
  // Target class display name; defaults to the source classroom name.
  name?: string
  shortName?: string
  term?: string
  templateSuffix?: string
  includeArchived?: boolean
}

// True when the target org has a `classroom50` config repo (i.e. it's been set
// up). A 404 -> false; any other error propagates.
async function targetOrgIsClassroom50(
  client: GitHubClient,
  org: string,
): Promise<boolean> {
  try {
    await client.request(`/repos/${org}/${CONFIG_REPO}`)
    return true
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return false
    throw err
  }
}

// Whether the OAuth app can act on the SOURCE org. A revoked/unapproved app
// still reads a PUBLIC template repo fine (so the per-assignment probe can't see
// the problem), but reading the viewer's own org membership is grant-gated: a
// 403 here means the app isn't authorized for that org. Returns true when the
// membership read succeeds, false on a 403 (authorization gap). Other errors
// (404 non-member, transient) are treated as "can't prove a problem" -> true, so
// a valid import is never false-positive-blocked.
async function sourceOrgAuthorized(
  client: GitHubClient,
  org: string,
): Promise<boolean> {
  try {
    await client.request(`/user/memberships/orgs/${encodeURIComponent(org)}`)
    return true
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 403) return false
    return true
  }
}

// True when `<shortName>/` already exists in the config repo (via a contents
// read of the classroom.json). A 404 -> false.
export async function classroomDirExists(
  client: GitHubClient,
  org: string,
  shortName: string,
): Promise<boolean> {
  try {
    await client.request(
      `/repos/${org}/${CONFIG_REPO}/contents/${encodeURIComponent(shortName)}/classroom.json`,
    )
    return true
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return false
    throw err
  }
}

export async function buildPreflight(
  client: GitHubClient,
  input: BuildPreflightInput,
): Promise<MigrationPreflight> {
  const templateSuffix = (input.templateSuffix ?? "").trim()

  const classroom = await resolveSource(client, input.source, {
    includeArchived: input.includeArchived,
  })

  const shortName = input.shortName?.trim()
    ? input.shortName.trim()
    : deriveShortName(classroom.name)
  // A user-supplied short-name still has to pass the pattern + team-slug guard.
  assertValidShortName(shortName)
  // Creation-time cap (#691): migration mints the classroom, so an explicit
  // over-cap short-name fails preflight. Derived names are already truncated.
  if (shortName.length > CLASSROOM_SHORT_NAME_MAX_LEN) {
    throw localizedError({
      key: "migration.error.shortNameTooLong",
      params: {
        shortName,
        length: shortName.length,
        max: CLASSROOM_SHORT_NAME_MAX_LEN,
      },
    })
  }

  const term = (input.term ?? "").trim()
  const name = input.name?.trim() ? input.name.trim() : classroom.name

  const assignments = await fetchAssignmentsForClassroom(client, classroom.id)
  const items: MigrationItem[] = []
  for (const a of assignments) {
    items.push(
      await classifyAssignment(
        client,
        input.targetOrg,
        templateSuffix,
        shortName,
        a,
      ),
    )
  }

  const blockers: MigrationBlocker[] = []
  if (!(await targetOrgIsClassroom50(client, input.targetOrg))) {
    blockers.push({ kind: "needs_org_setup", params: { org: input.targetOrg } })
  } else if (await classroomDirExists(client, input.targetOrg, shortName)) {
    // Only meaningful once we know the config repo exists.
    blockers.push({ kind: "dir_exists", params: { shortName } })
  }

  // If any assignment's starter couldn't be read because the app isn't approved
  // for its (cross-)org, that's a fixable authorization gap affecting every
  // assignment from that org — surface it as a blocker with grant links rather
  // than leaving the teacher to decode per-item skips. Dedup by org.
  const accessOrgs = new Set(
    items
      .filter((i) => i.reason?.key === "migration.reason.sourceOrgAccess")
      .map((i) => i.reason?.params?.org)
      .filter((org): org is string => Boolean(org)),
  )
  // Public starter repos read fine even when the app's org access is revoked, so
  // the per-item probe above misses that case. Independently verify the source
  // classroom's org is authorized (a grant-gated membership read) and add the
  // same blocker when it isn't — this is the case that only failed at generate
  // time before.
  const sourceOrgLogin = classroom.organization.login
  if (!(await sourceOrgAuthorized(client, sourceOrgLogin))) {
    accessOrgs.add(sourceOrgLogin)
  }
  for (const org of accessOrgs) {
    blockers.push({ kind: "source_org_access", params: { org } })
  }

  const counts = {
    import: items.filter((i) => i.action === "import").length,
    reuse: items.filter((i) => i.action === "reuse").length,
    skip: items.filter((i) => i.action === "skip").length,
  }

  return {
    classroom,
    targetOrg: input.targetOrg,
    name,
    shortName,
    term,
    templateSuffix,
    items,
    counts,
    blockers,
  }
}
