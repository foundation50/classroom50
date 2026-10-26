import type { GitHubClient } from "@/github-core/client"
import { getConfigRepoBranch } from "@/github-core/configRepoReads"
import { tolerateGitHubError } from "@/github-core/errors"
import type { Assignment } from "@/types/classroom"
import { assignmentsFilePath, teamsFilePath } from "@/util/configRepoPaths"
import { withGitConflictRetry } from "../classrooms"
import {
  commitConfigRepoFiles,
  jsonFileEntry,
  readConfigRepoHeadAt,
} from "../configRepoWrite"
import { getAssignmentsFile } from "../queries/assignments"
import { getTeamsFile, removeTeamFromSnapshot } from "./teamsFile"

// The counters a team-mode assignment has retired, tolerant of a hand-edited
// or older entry: non-integers and values below 1 are dropped, never thrown
// on. Absent reads as none.
export function retiredGroupCounters(
  entry: Pick<Assignment, "retired_group_counters"> | undefined,
): Set<number> {
  const retired = new Set<number>()
  const raw: unknown = entry?.retired_group_counters
  if (!Array.isArray(raw)) return retired
  for (const value of raw) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
      retired.add(value)
    }
  }
  return retired
}

// Record counter n as retired on an assignment entry: sorted, deduped, and
// append-only (a counter already listed stays listed). Preserves every other
// field of the entry untouched.
export function withRetiredGroupCounter(
  entry: Assignment,
  n: number,
): Assignment {
  const retired = retiredGroupCounters(entry)
  retired.add(n)
  return {
    ...entry,
    retired_group_counters: [...retired].sort((a, b) => a - b),
  }
}

// The bookkeeping for one group-team deletion, in ONE config-repo commit:
// drop the team's teams.json row and retire its counter on the assignment
// entry. One commit because the two halves must not diverge: a retired
// counter with a lingering row is harmless, but a dropped row without the
// retired counter re-opens the collision (#1128). The assignment entry may be
// gone already (assignment deleted while its teams lingered); then only the
// row is dropped, since nothing can allocate for a deleted assignment.
export async function recordGroupTeamDeletion(
  client: GitHubClient,
  input: {
    org: string
    classroom: string
    assignment: string
    slug: string
    n: number
  },
): Promise<void> {
  const { org, classroom, assignment, slug, n } = input
  await withGitConflictRetry(async () => {
    const configBranch = await getConfigRepoBranch(client, org)
    const head = await readConfigRepoHeadAt(client, org, configBranch)
    const [teams, assignments] = await Promise.all([
      getTeamsFile(client, { org, classroom, ref: head.headSha }),
      // A classroom whose assignments.json is gone has nothing left to
      // allocate for; the row drop still proceeds.
      tolerateGitHubError(
        () =>
          getAssignmentsFile(client, {
            org,
            path: assignmentsFilePath(classroom),
            ref: head.headSha,
          }),
        null,
      ),
    ])
    const tree = [
      jsonFileEntry(
        teamsFilePath(classroom),
        removeTeamFromSnapshot(teams, assignment, slug),
      ),
    ]
    if (assignments?.assignments.some((entry) => entry.slug === assignment)) {
      tree.push(
        jsonFileEntry(assignmentsFilePath(classroom), {
          ...assignments,
          assignments: assignments.assignments.map((entry) =>
            entry.slug === assignment
              ? withRetiredGroupCounter(entry, n)
              : entry,
          ),
        }),
      )
    }
    await commitConfigRepoFiles(
      client,
      org,
      head,
      tree,
      `Delete group ${n}: ${classroom}/${assignment}`,
    )
  })
}
