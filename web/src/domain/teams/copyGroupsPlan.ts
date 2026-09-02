import type { GitHubClient } from "@/github-core/client"
import type { TeamFormation } from "@/types/classroom"
import {
  addGroupTeamMember,
  createGroupTeam,
  type GroupTeamRef,
} from "./groupTeams"
import { syncTeamsSnapshot } from "./teamsFile"

// One planned group of a copy plan: identity (`key` = the SOURCE team's slug,
// stable across edits), the display name carried over (absent = the source
// group was unnamed and the created group falls back to "Group <n>"), and the
// member logins to add. Nothing here is written until applyGroupsPlan.
export type PlannedGroup = {
  key: string
  name?: string
  members: string[]
}

// Build the initial plan from a SOURCE assignment's live teams: one planned
// group per source group, carrying the display name and members. A login
// appearing in several source groups is kept only in the first (one student,
// one group). A team whose members didn't resolve plans as empty.
export function buildCopyPlan(
  sourceTeams: readonly Pick<GroupTeamRef, "slug" | "name">[],
  sourceMembersBySlug: ReadonlyMap<string, readonly { login: string }[]>,
): PlannedGroup[] {
  const seen = new Set<string>()
  return sourceTeams.map((team) => {
    const members: string[] = []
    for (const member of sourceMembersBySlug.get(team.slug) ?? []) {
      const login = member.login.trim()
      const lower = login.toLowerCase()
      if (!login || seen.has(lower)) continue
      seen.add(lower)
      members.push(login)
    }
    return {
      key: team.slug,
      ...(team.name ? { name: team.name } : {}),
      members,
    }
  })
}

// Every login used anywhere in the plan (lowercased) — the add pickers exclude
// these so one student can't land in two planned groups.
export function usedLogins(plan: readonly PlannedGroup[]): Set<string> {
  const used = new Set<string>()
  for (const group of plan) {
    for (const login of group.members) used.add(login.trim().toLowerCase())
  }
  return used
}

// What blocks saving one planned group: more members than the CURRENT
// assignment's cap (the source may have a bigger one), or members already on
// one of the current assignment's existing teams.
export type PlanIssue = {
  key: string
  overCapacity?: { count: number; max: number }
  takenMembers?: string[]
}

// Validate a plan against the current assignment: group size cap and logins
// already taken by its existing teams (`takenLogins`, lowercased). Groups
// without problems are omitted; an empty result means the plan is saveable.
export function planIssues(
  plan: readonly PlannedGroup[],
  opts: { maxGroupSize?: number; takenLogins?: ReadonlySet<string> },
): PlanIssue[] {
  const issues: PlanIssue[] = []
  for (const group of plan) {
    const issue: PlanIssue = { key: group.key }
    if (
      opts.maxGroupSize !== undefined &&
      group.members.length > opts.maxGroupSize
    ) {
      issue.overCapacity = {
        count: group.members.length,
        max: opts.maxGroupSize,
      }
    }
    const taken = group.members.filter((login) =>
      opts.takenLogins?.has(login.trim().toLowerCase()),
    )
    if (taken.length > 0) issue.takenMembers = taken
    if (issue.overCapacity || issue.takenMembers) issues.push(issue)
  }
  return issues
}

export type ApplyGroupsPlanProgress = { current: number; total: number }

export type ApplyGroupsPlanResult = {
  // Planned groups that became real teams, in creation order.
  created: { key: string; slug: string }[]
  // Member adds that failed on an otherwise created team. Non-fatal: the
  // teacher fixes membership afterward (mirrors `gh teacher team create`).
  memberWarnings: { key: string; username: string; error: unknown }[]
  // Set when a team CREATE failed: the apply stopped there, and `remaining`
  // lists the planned groups (the failed one first) that were not created.
  createFailure?: { key: string; error: unknown; remaining: string[] }
}

// Apply a copy plan to the current assignment, sequentially: for each planned
// group createGroupTeam (real counters are allocated here, not in the
// preview) then addGroupTeamMember per member; finally ONE teams.json sync.
// A failed create stops the apply (honest partial result); a failed member
// add records a warning and continues. Never throws for per-item failures —
// the result carries them.
export async function applyGroupsPlan(
  client: GitHubClient,
  org: string,
  input: {
    classroom: string
    assignment: string
    plan: readonly PlannedGroup[]
    formation: TeamFormation
    creatorLogin: string
    maxGroupSize?: number
    rosterLogins?: ReadonlySet<string>
    onProgress?: (progress: ApplyGroupsPlanProgress) => void
  },
): Promise<ApplyGroupsPlanResult> {
  const { classroom, assignment, plan, formation, creatorLogin } = input
  const result: ApplyGroupsPlanResult = { created: [], memberWarnings: [] }

  for (const [index, group] of plan.entries()) {
    input.onProgress?.({ current: index + 1, total: plan.length })
    let team: GroupTeamRef
    try {
      team = await createGroupTeam(client, org, {
        classroom,
        assignment,
        displayName: group.name,
        creatorLogin,
        formation,
      })
    } catch (err) {
      result.createFailure = {
        key: group.key,
        error: err,
        remaining: plan.slice(index).map((remaining) => remaining.key),
      }
      break
    }
    result.created.push({ key: group.key, slug: team.slug })

    let memberCount = 0
    for (const username of group.members) {
      try {
        await addGroupTeamMember(client, org, {
          teamSlug: team.slug,
          username,
          currentMemberCount: memberCount,
          maxGroupSize: input.maxGroupSize,
          rosterLogins: input.rosterLogins,
        })
        memberCount++
      } catch (err) {
        result.memberWarnings.push({ key: group.key, username, error: err })
      }
    }
  }

  if (result.created.length > 0) {
    // Best-effort, like every teacher-side resync: a failed sync leaves the
    // drift badge to catch it.
    try {
      await syncTeamsSnapshot(client, { org, classroom, assignment, formation })
    } catch {
      // The drift badge surfaces a stale snapshot.
    }
  }

  return result
}
