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
import { assertValidShortName, deriveShortName } from "./translate"
import type {
  MigrationBlocker,
  MigrationItem,
  MigrationPreflight,
} from "./types"

export type BuildPreflightInput = {
  // Numeric classroom id or source org login.
  source: string
  targetOrg: string
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

  const term = (input.term ?? "").trim()

  const assignments = await fetchAssignmentsForClassroom(client, classroom.id)
  const items: MigrationItem[] = []
  for (const a of assignments) {
    items.push(await classifyAssignment(client, input.targetOrg, templateSuffix, a))
  }

  const blockers: MigrationBlocker[] = []
  if (!(await targetOrgIsClassroom50(client, input.targetOrg))) {
    blockers.push({ kind: "needs_org_setup", params: { org: input.targetOrg } })
  } else if (await classroomDirExists(client, input.targetOrg, shortName)) {
    // Only meaningful once we know the config repo exists.
    blockers.push({ kind: "dir_exists", params: { shortName } })
  }

  const counts = {
    import: items.filter((i) => i.action === "import").length,
    reuse: items.filter((i) => i.action === "reuse").length,
    skip: items.filter((i) => i.action === "skip").length,
  }

  return {
    classroom,
    targetOrg: input.targetOrg,
    shortName,
    term,
    templateSuffix,
    items,
    counts,
    blockers,
  }
}
