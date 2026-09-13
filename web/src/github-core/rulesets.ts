// Web mirror of the CLI's org ruleset install (classroom50-cli init_repo.go
// ensureClassroomRulesets). Two org branch rulesets protect submission history
// and lock the Feedback PR base branch, with owners and every classroom's
// staff teams exempt from the lock. Reconciled by name: PUT over an existing
// ruleset, else POST to create. Definitions must match the CLI exactly — a
// divergence is a parity bug.

import type { GitHubClient } from "./client"
import { paginateAll } from "./paginate"
import type { CheckVerdict } from "./orgChecks"
import { readFailedDetail } from "./orgChecks"
import { getClassroomJson } from "./configRepoReads"
import { listClassroomDirs } from "./queries/orgReads"
import { STAFF_TEAM_PRIVACY } from "./types"
import { FEEDBACK_BASE_BRANCH } from "@/util/feedbackPr"
import { mapWithConcurrency } from "@/util/concurrency"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_GITHUB_SETUP } from "@/lib/logScopes"

const log = logger.scope(LOG_SCOPE_GITHUB_SETUP)

export const RULESET_NAME_SUBMISSION_HISTORY =
  "classroom50-protect-submission-history"
export const RULESET_NAME_FEEDBACK_BASE = "classroom50-feedback-base-lock"

type RefPatternCondition = {
  include: string[]
  exclude: string[]
}

// `exempt` means GitHub doesn't evaluate the rules for that actor at all, so
// they get a plain Merge button instead of the "bypass rules" checkbox and an
// audit entry; `always` keeps the checkbox as a deliberate break-glass step.
export type RulesetBypassActor = {
  actor_id: number
  actor_type: "OrganizationAdmin" | "Team"
  bypass_mode: "always" | "exempt"
}

type RulesetRule = { type: "non_fast_forward" | "deletion" | "update" }

export type OrgRulesetBody = {
  name: string
  target: "branch"
  enforcement: "active"
  conditions: {
    ref_name: RefPatternCondition
    repository_name: RefPatternCondition
  }
  bypass_actors: RulesetBypassActor[]
  rules: RulesetRule[]
}

// GitHub's fixed actor_id for the OrganizationAdmin role (the org owner).
const ORG_ADMIN_ACTOR_ID = 1

const ALL_REPOS: RefPatternCondition = { include: ["~ALL"], exclude: [] }

// The feedback-base lock's bypass list: org owners plus every classroom staff
// team, all exempt. Students are collaborators on their own repo and never on
// a staff team, so the `update` rule binds them while staff merge the Feedback
// PR like any other PR. Sorted by team id so a reconcile compares stably.
export function feedbackBaseBypassActors(
  staffTeamIds: readonly number[],
): RulesetBypassActor[] {
  const ids = [...new Set(staffTeamIds.filter((id) => id > 0))].sort(
    (a, b) => a - b,
  )
  return [
    {
      actor_id: ORG_ADMIN_ACTOR_ID,
      actor_type: "OrganizationAdmin",
      bypass_mode: "exempt",
    },
    ...ids.map((id): RulesetBypassActor => ({
      actor_id: id,
      actor_type: "Team",
      bypass_mode: "exempt",
    })),
  ]
}

// staffTeamIds are the teacher/head-TA/TA team ids of every classroom in the
// org; they only affect the feedback-base lock's bypass list.
export function classroomRulesetBodies(
  staffTeamIds: readonly number[],
): OrgRulesetBody[] {
  return [
    {
      name: RULESET_NAME_SUBMISSION_HISTORY,
      target: "branch",
      enforcement: "active",
      conditions: {
        // ~DEFAULT_BRANCH follows each repo's actual default branch.
        ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
        repository_name: ALL_REPOS,
      },
      // `always`, not exempt: an owner rewriting a student's history should
      // be a deliberate, audited bypass.
      bypass_actors: [
        {
          actor_id: ORG_ADMIN_ACTOR_ID,
          actor_type: "OrganizationAdmin",
          bypass_mode: "always",
        },
      ],
      // non_fast_forward blocks force-push; deletion blocks delete.
      rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
    },
    {
      name: RULESET_NAME_FEEDBACK_BASE,
      target: "branch",
      enforcement: "active",
      conditions: {
        ref_name: {
          include: [`refs/heads/${FEEDBACK_BASE_BRANCH}`],
          exclude: [],
        },
        repository_name: ALL_REPOS,
      },
      bypass_actors: feedbackBaseBypassActors(staffTeamIds),
      // update restricts pushes/merges to bypass actors (owners and staff
      // teams); deletion blocks delete. Creation stays allowed so accept or
      // the runner can land the branch once.
      rules: [{ type: "update" }, { type: "deletion" }],
    },
  ]
}

type OrgRuleset = { id: number; name: string }

type OrgRulesetWithActors = OrgRuleset & {
  bypass_actors?: RulesetBypassActor[]
}

// The names never depend on team ids.
const RULESET_NAMES = classroomRulesetBodies([]).map((r) => r.name)

// List existing org rulesets, mapping name -> id (paginated to exhaustion).
async function listOrgRulesets(
  client: GitHubClient,
  org: string,
): Promise<Map<string, number>> {
  const rulesets = await paginateAll<OrgRuleset>(
    client,
    (page) => `/orgs/${org}/rulesets?per_page=100&page=${page}`,
  )
  const ids = new Map<string, number>()
  for (const r of rulesets) ids.set(r.name, r.id)
  return ids
}

// checkRulesets: enforced only when both classroom rulesets are present and
// every expected staff team is exempt on the feedback-base lock. A team missing
// from that list (a classroom created by an older release, or a team added out
// of band) leaves its staff unable to merge feedback PRs, which is exactly what
// Fix it (repairRulesets) rebuilds.
export async function checkRulesets(
  client: GitHubClient,
  org: string,
  expectedStaffTeamIds: readonly number[] = [],
): Promise<CheckVerdict> {
  try {
    const existing = await listOrgRulesets(client, org)
    const missing = RULESET_NAMES.filter((name) => !existing.has(name))
    if (missing.length > 0) {
      return {
        state: "unenforced",
        detail: {
          key: "orgSettings.audit.detail.rulesetsMissing",
          params: { names: missing.join(", ") },
        },
      }
    }
    const feedbackId = existing.get(RULESET_NAME_FEEDBACK_BASE)
    if (feedbackId !== undefined && expectedStaffTeamIds.length > 0) {
      const current = await client.request<OrgRulesetWithActors>(
        `/orgs/${org}/rulesets/${feedbackId}`,
      )
      const exempt = new Set(
        (current.bypass_actors ?? [])
          .filter((a) => a.actor_type === "Team" && a.bypass_mode === "exempt")
          .map((a) => a.actor_id),
      )
      const unlisted = expectedStaffTeamIds.filter((id) => !exempt.has(id))
      if (unlisted.length > 0) {
        return {
          state: "unenforced",
          detail: {
            key: "orgSettings.audit.detail.rulesetStaffTeamsMissing",
            params: { count: unlisted.length },
          },
        }
      }
    }
    return { state: "enforced" }
  } catch (err) {
    return { state: "unreadable", detail: readFailedDetail(err) }
  }
}

export type RulesetsRepairResult = {
  status: "complete" | "warning"
  message: string
  created: string[]
  updated: string[]
  failed: string[]
}

// repairRulesets: reconcile both rulesets — PUT over an existing one (by id),
// else POST to create. staffTeamIds are every classroom's staff team ids, so
// the PUT rebuilds the feedback-base bypass list from scratch (a team deleted
// out of band drops off). Warn-and-continue on any single failure (init never
// fails on a ruleset error), mirroring the CLI's ensureClassroomRulesets.
export async function repairRulesets(
  client: GitHubClient,
  org: string,
  staffTeamIds: readonly number[],
): Promise<RulesetsRepairResult> {
  const created: string[] = []
  const updated: string[] = []
  const failed: string[] = []

  let existing: Map<string, number>
  try {
    existing = await listOrgRulesets(client, org)
  } catch (err) {
    log.warn("could not list org rulesets; skipping ruleset repair", {
      org,
      err,
    })
    return {
      status: "warning",
      message: `${org}: could not list org rulesets; apply Feedback PR branch protections manually.`,
      created,
      updated,
      failed: [...RULESET_NAMES],
    }
  }

  for (const body of classroomRulesetBodies(staffTeamIds)) {
    const id = existing.get(body.name)
    try {
      if (id !== undefined) {
        await client.request(`/orgs/${org}/rulesets/${id}`, {
          method: "PUT",
          body,
        })
        updated.push(body.name)
      } else {
        await client.request(`/orgs/${org}/rulesets`, {
          method: "POST",
          body,
        })
        created.push(body.name)
      }
    } catch (err) {
      log.warn("ruleset apply failed", { org, ruleset: body.name, err })
      failed.push(body.name)
    }
  }

  return {
    status: failed.length === 0 ? "complete" : "warning",
    message:
      failed.length === 0
        ? `${org}: org rulesets reconciled.`
        : `${org}: some org rulesets could not be applied (${failed.join(", ")}); review them in org settings → rules.`,
    created,
    updated,
    failed,
  }
}

// Add or drop staff teams on the feedback-base lock's bypass list without
// re-deriving the whole list: read the ruleset, merge the Team entries, PUT
// the full definition back only when something changes. The incremental
// sibling of repairRulesets, cheap enough to run on every classroom visit.
// Returns false (after logging) when the ruleset isn't installed yet; a later
// org setup run rebuilds the list from every classroom, so nothing is lost.
export async function updateFeedbackBaseBypassTeams(
  client: GitHubClient,
  org: string,
  change: { add?: readonly number[]; remove?: readonly number[] },
): Promise<boolean> {
  const existing = await listOrgRulesets(client, org)
  const id = existing.get(RULESET_NAME_FEEDBACK_BASE)
  if (id === undefined) {
    log.warn("feedback-base ruleset not installed; staff team bypass skipped", {
      org,
    })
    return false
  }
  const current = await client.request<OrgRulesetWithActors>(
    `/orgs/${org}/rulesets/${id}`,
  )
  const remove = new Set(change.remove ?? [])
  const actors = current.bypass_actors ?? []
  const exempt = new Set(
    actors
      .filter((a) => a.actor_type === "Team" && a.bypass_mode === "exempt")
      .map((a) => a.actor_id),
  )
  const ownerExempt = actors.some(
    (a) => a.actor_type === "OrganizationAdmin" && a.bypass_mode === "exempt",
  )
  const keep = [...exempt].filter((teamId) => !remove.has(teamId))
  const missing = (change.add ?? []).filter((teamId) => !exempt.has(teamId))
  const dropping = [...exempt].some((teamId) => remove.has(teamId))
  if (ownerExempt && missing.length === 0 && !dropping) return true
  const body = classroomRulesetBodies([...keep, ...missing]).find(
    (r) => r.name === RULESET_NAME_FEEDBACK_BASE,
  )
  await client.request(`/orgs/${org}/rulesets/${id}`, {
    method: "PUT",
    body,
  })
  return true
}

// Best-effort: make sure staff teams are exempt from the feedback-base lock so
// their members can merge feedback PRs. Idempotent and cheap when nothing is
// missing (two reads, no write), so callers run it on create and on every
// reconcile alike. A failure is logged, never thrown; the org audit flags the
// gap and Fix it rebuilds the list.
export async function exemptStaffTeams(
  client: GitHubClient,
  org: string,
  teamIds: readonly number[],
): Promise<void> {
  if (teamIds.length === 0) return
  try {
    await updateFeedbackBaseBypassTeams(client, org, { add: teamIds })
  } catch (err) {
    log.warn("could not exempt staff teams from the feedback-base lock", {
      org,
      teamIds,
      err,
    })
  }
}

// Best-effort: drop staff teams about to be deleted from the feedback-base
// bypass list, so the ruleset never references an actor GitHub no longer
// knows. Run before the team delete.
export async function revokeStaffTeams(
  client: GitHubClient,
  org: string,
  teamIds: readonly number[],
): Promise<void> {
  if (teamIds.length === 0) return
  try {
    await updateFeedbackBaseBypassTeams(client, org, { remove: teamIds })
  } catch (err) {
    log.warn("could not drop staff teams from the feedback-base lock", {
      org,
      teamIds,
      err,
    })
  }
}

type StaffTeamRef = { id: number; slug: string }

// Every classroom's recorded staff team refs (teacher, hta, ta), read from each
// classroom.json in the config repo: the input repairRulesets and checkRulesets
// need. A missing config repo (fresh org) or an unreadable classroom.json
// contributes nothing rather than failing setup.
export async function collectStaffTeams(
  client: GitHubClient,
  org: string,
): Promise<StaffTeamRef[]> {
  let dirs: { name: string }[]
  try {
    dirs = await listClassroomDirs(client, org)
  } catch {
    return []
  }
  const byId = new Map<number, StaffTeamRef>()
  await mapWithConcurrency(dirs, 8, async (dir) => {
    try {
      const json = await getClassroomJson(client, { org, classroom: dir.name })
      for (const ref of [
        json.teams?.teacher,
        json.teams?.hta,
        json.teams?.ta,
      ]) {
        if (
          ref &&
          Number.isInteger(ref.id) &&
          ref.id > 0 &&
          typeof ref.slug === "string"
        )
          byId.set(ref.id, { id: ref.id, slug: ref.slug })
      }
    } catch {
      log.debug("classroom.json unreadable, no staff team ids", {
        org,
        classroom: dir.name,
      })
    }
  })
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

// The audit-side input: ids only, no writes.
export async function collectStaffTeamIds(
  client: GitHubClient,
  org: string,
): Promise<number[]> {
  return (await collectStaffTeams(client, org)).map((t) => t.id)
}

// Make every staff team a valid bypass actor (GitHub rejects a `secret` team)
// and return the ids to hand repairRulesets. Teams created by an older
// release were secret; the PATCH here is the one-time upgrade. A team that
// can't be read or patched is logged and left out, so one bad team can't sink
// the whole ruleset PUT (the audit keeps flagging it).
export async function prepareStaffTeams(
  client: GitHubClient,
  org: string,
  teams: readonly StaffTeamRef[],
): Promise<number[]> {
  const ids: number[] = []
  await mapWithConcurrency(teams, 4, async (team) => {
    try {
      const existing = await client.request<{ privacy?: string }>(
        `/orgs/${org}/teams/${team.slug}`,
      )
      if (existing.privacy !== STAFF_TEAM_PRIVACY) {
        await client.request(`/orgs/${org}/teams/${team.slug}`, {
          method: "PATCH",
          body: { privacy: STAFF_TEAM_PRIVACY },
        })
      }
      ids.push(team.id)
    } catch (err) {
      log.warn("could not make staff team visible for the ruleset bypass", {
        org,
        team: team.slug,
        err,
      })
    }
  })
  return ids.sort((a, b) => a - b)
}

// The repair-side input: collect, make visible, return ids.
export async function collectBypassStaffTeamIds(
  client: GitHubClient,
  org: string,
): Promise<number[]> {
  return prepareStaffTeams(client, org, await collectStaffTeams(client, org))
}
