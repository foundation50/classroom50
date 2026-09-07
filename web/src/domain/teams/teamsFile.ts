import type { GitHubClient } from "@/github-core/client"
import type { TeamFormation } from "@/types/classroom"
import { GitHubAPIError } from "@/github-core/errors"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import {
  createGitCommit,
  createGitTree,
  updateRef,
} from "@/github-core/mutations"
import { CONFIG_REPO } from "@/util/configRepo"
import { decodeBase64Utf8 } from "@/util/github"
import { prefixCommit } from "@/util/commit"
import { withGitConflictRetry } from "../classrooms"
import { listTeamMembers } from "@/github-core/queries"
import { listAssignmentGroupTeams } from "./groupTeams"

// Schema sentinel for <classroom>/teams.json (classroom50/teams/v1) — the
// teacher-side snapshot of a team-mode assignment's group teams. Source of
// truth for teacher formation, drift baseline for student formation. Mirrors
// schemas/teams-v1.schema.json; keep in lockstep.
export const TEAMS_SCHEMA_V1 = "classroom50/teams/v1"

// One snapshotted group team. `slug` is the canonical classroom50-group-* name
// (== slug), `id` the immutable handle for the delete guard, `members` the
// logins at snapshot time, `formation` who formed it.
export type TeamsFileTeam = {
  slug: string
  id: number
  name?: string
  members: string[]
  formation: TeamFormation
}

// Buckets and the file itself carry Record<string, unknown> so unknown fields
// written by a newer release survive a read-modify-write (additive evolution).
export type TeamsFileAssignment = {
  teams: TeamsFileTeam[]
} & Record<string, unknown>

export type TeamsFile = {
  schema: typeof TEAMS_SCHEMA_V1
  assignments: Record<string, TeamsFileAssignment>
} & Record<string, unknown>

export function emptyTeamsFile(): TeamsFile {
  return { schema: TEAMS_SCHEMA_V1, assignments: {} }
}

export function teamsFilePath(classroom: string): string {
  return `${classroom}/teams.json`
}

// Read <classroom>/teams.json from the config repo. Tolerates an absent file
// (404 -> empty skeleton) — a classroom has no teams.json until the first
// team-mode snapshot write. `ref` pins the read to a commit for the
// read-modify-write path; omit it for a latest read.
export async function getTeamsFile(
  client: GitHubClient,
  input: { org: string; classroom: string; ref?: string },
): Promise<TeamsFile> {
  const { org, classroom, ref } = input
  const path = teamsFilePath(classroom)
  let file: { type: string; content: string }
  try {
    file = await client.request<{ type: string; content: string }>(
      `/repos/${org}/${CONFIG_REPO}/contents/${path}${
        ref ? `?ref=${encodeURIComponent(ref)}` : ""
      }`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) {
      return emptyTeamsFile()
    }
    throw err
  }
  if (file.type !== "file") {
    throw new Error(`${path} is not a file`)
  }
  const parsed = JSON.parse(decodeBase64Utf8(file.content)) as TeamsFile
  // A hand-edited file may lack the map; normalize so callers can index it.
  if (!parsed.assignments || typeof parsed.assignments !== "object") {
    return { ...parsed, schema: TEAMS_SCHEMA_V1, assignments: {} }
  }
  return parsed
}

// Replace one assignment's team list, preserving every unknown field at the
// file and bucket level (spread source first, like createEdit's
// read-modify-write). The team list itself is snapshot-replaced wholesale —
// it is re-derived from live GitHub state on every write, never merged.
export function upsertAssignmentTeams(
  file: TeamsFile,
  assignment: string,
  teams: TeamsFileTeam[],
): TeamsFile {
  const bucket = file.assignments[assignment]
  return {
    ...file,
    schema: TEAMS_SCHEMA_V1,
    assignments: {
      ...file.assignments,
      [assignment]: { ...(bucket ?? {}), teams },
    },
  }
}

// Remove one team from an assignment's snapshot (after a team delete),
// preserving unknown fields like upsertAssignmentTeams. A missing bucket is a
// no-op.
export function removeTeamFromSnapshot(
  file: TeamsFile,
  assignment: string,
  slug: string,
): TeamsFile {
  const bucket = file.assignments[assignment]
  if (!bucket) return file
  return upsertAssignmentTeams(
    file,
    assignment,
    (bucket.teams ?? []).filter((team) => team.slug !== slug),
  )
}

// Commit an updated teams.json via the same git tree/commit path as the
// assignment writes. `update` maps the freshly-read file to the next one; the
// whole read -> update -> commit runs inside withGitConflictRetry, so a
// concurrent config-repo write is re-read and retried rather than lost.
export async function writeTeamsFile(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    message: string
    update: (file: TeamsFile) => TeamsFile
  },
): Promise<void> {
  const { org, classroom, message, update } = input
  await withGitConflictRetry(async () => {
    const configBranch = await getConfigRepoBranch(client, org)
    const ref = await getBranchRef(client, org, configBranch)
    const commit = await getCommit(client, org, ref.object.sha)
    const current = await getTeamsFile(client, {
      org,
      classroom,
      ref: ref.object.sha,
    })
    const next = update(current)

    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: [
        {
          path: teamsFilePath(classroom),
          mode: "100644",
          type: "blob",
          content: JSON.stringify(next, null, 2) + "\n",
        },
      ],
    })
    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(message),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })
    await updateRef(client, org, newCommit.sha, configBranch)
  })
}

// Snapshot one assignment's group teams into teams.json (teacher-side write).
export async function saveTeamsSnapshot(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    assignment: string
    teams: TeamsFileTeam[]
  },
): Promise<void> {
  const { org, classroom, assignment, teams } = input
  await writeTeamsFile(client, {
    org,
    classroom,
    message: `Update teams: ${classroom}/${assignment}`,
    update: (file) => upsertAssignmentTeams(file, assignment, teams),
  })
}

// Build the snapshot rows from LIVE GitHub state (team list + membership) —
// what every teacher-side write records. `formation` stamps who formed the
// teams (the assignment's team_formation).
export async function snapshotLiveTeams(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    assignment: string
    formation: TeamFormation
  },
): Promise<TeamsFileTeam[]> {
  const { org, classroom, assignment, formation } = input
  const teams = await listAssignmentGroupTeams(
    client,
    org,
    classroom,
    assignment,
  )
  const rows: TeamsFileTeam[] = []
  for (const team of teams) {
    const members = await listTeamMembers(client, org, team.slug)
    rows.push({
      slug: team.slug,
      id: team.id,
      ...(team.name ? { name: team.name } : {}),
      members: members.map((m) => m.login),
      formation,
    })
  }
  return rows
}

// Re-derive and commit the snapshot from live state in one call — run after
// every teacher-side team mutation, and by the drift note's refresh action.
export async function syncTeamsSnapshot(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    assignment: string
    formation: TeamFormation
  },
): Promise<void> {
  const teams = await snapshotLiveTeams(client, input)
  await saveTeamsSnapshot(client, { ...input, teams })
}

// Compare a snapshot bucket against live membership: the slugs whose recorded
// members differ from the live set (order-insensitive, case-insensitive), plus
// live teams the snapshot doesn't know at all. A live team whose members
// haven't resolved yet is skipped (unknown, not drifted).
export function snapshotDrift(
  snapshotTeams: TeamsFileTeam[] | undefined,
  liveMembersBySlug: ReadonlyMap<string, { login: string }[]>,
): { changed: Set<string>; missing: Set<string> } {
  const changed = new Set<string>()
  const missing = new Set<string>()
  const bySlug = new Map((snapshotTeams ?? []).map((team) => [team.slug, team]))
  for (const [slug, members] of liveMembersBySlug) {
    const recorded = bySlug.get(slug)
    if (!recorded) {
      missing.add(slug)
      continue
    }
    const live = members
      .map((m) => m.login.toLowerCase())
      .sort()
      .join(",")
    const snap = (recorded.members ?? [])
      .map((m) => m.toLowerCase())
      .sort()
      .join(",")
    if (live !== snap) changed.add(slug)
  }
  return { changed, missing }
}
