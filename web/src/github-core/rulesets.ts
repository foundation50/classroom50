// Web mirror of the CLI's org ruleset install (cli/gh-teacher/internal/orgrules,
// Ensure). Two org branch rulesets protect submission history
// and lock the Feedback PR base branch, with owners and every classroom's
// staff teams exempt from the lock. Reconciled by name: PUT over an existing
// ruleset, else POST to create. Definitions must match the CLI exactly — a
// divergence is a parity bug.

import type { GitHubClient } from "./client"
import { paginateAll } from "./paginate"
import type { CheckVerdict } from "./orgChecks"
import { readFailedDetail } from "./orgChecks"
import { forEachClassroom } from "./configRepoReads"
import { STAFF_TEAM_PRIVACY } from "./types"
import { GitHubAPIError } from "./errors"
import { FEEDBACK_BASE_BRANCH } from "@/util/feedbackPr"
import { classroomTeamSlug } from "@/util/teamSlug"
import { STAFF_ROLES, type StaffRole } from "@/types/classroom"
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
// the feedback-base lock's bypass list is exactly what we'd install: owners
// exempt, every expected staff team exempt, nothing else. A missing or `always`
// staff entry leaves staff unable to merge feedback PRs; a foreign actor is a
// hole in the lock. Both are what Fix it (repairRulesets) rebuilds.
// `expectedStaffTeamIds === null` means the classroom list could not be read,
// which is reported as unreadable rather than judged against an empty list.
export async function checkRulesets(
  client: GitHubClient,
  org: string,
  expectedStaffTeamIds: readonly number[] | null = [],
): Promise<CheckVerdict> {
  if (expectedStaffTeamIds === null) {
    return {
      state: "unreadable",
      detail: { key: "orgSettings.audit.detail.rulesetStaffTeamsUnreadable" },
    }
  }
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
    if (feedbackId === undefined) return { state: "enforced" }
    const current = await client.request<OrgRulesetWithActors>(
      `/orgs/${org}/rulesets/${feedbackId}`,
    )
    const actors = current.bypass_actors ?? []
    const ownerExempt = actors.some(
      (a) => a.actor_type === "OrganizationAdmin" && a.bypass_mode === "exempt",
    )
    if (!ownerExempt) {
      return {
        state: "unenforced",
        detail: { key: "orgSettings.audit.detail.rulesetOwnerNotExempt" },
      }
    }
    const expected = new Set(expectedStaffTeamIds)
    const exempt = new Set(
      actors
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
    const unexpected = actors.filter(
      (a) =>
        !(a.actor_type === "OrganizationAdmin" && a.bypass_mode === "exempt") &&
        !(a.actor_type === "Team" && expected.has(a.actor_id)),
    )
    if (unexpected.length > 0) {
      return {
        state: "unenforced",
        detail: {
          key: "orgSettings.audit.detail.rulesetUnexpectedBypass",
          params: { count: unexpected.length },
        },
      }
    }
    return { state: "enforced" }
  } catch (err) {
    return { state: "unreadable", detail: readFailedDetail(err) }
  }
}

// The audit's one-call entry: read the classrooms, then judge the ruleset. A
// collector failure becomes unreadable, never a green verdict against an empty
// expectation.
export async function auditRulesets(
  client: GitHubClient,
  org: string,
): Promise<CheckVerdict> {
  let expected: number[] | null
  try {
    expected = await collectStaffTeamIds(client, org)
  } catch (err) {
    log.warn("could not read classroom staff teams for the ruleset audit", {
      org,
      err,
    })
    expected = null
  }
  return checkRulesets(client, org, expected)
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
// out of band drops off). null means the classroom list could not be read: the
// Team actors already on the ruleset are kept and the result is a warning, so
// a transient failure never wipes staff exemptions. Warn-and-continue on any
// single failure (init never fails on a ruleset error), mirroring the CLI's
// orgrules.Ensure.
export async function repairRulesets(
  client: GitHubClient,
  org: string,
  staffTeamIds: readonly number[] | null,
): Promise<RulesetsRepairResult> {
  const created: string[] = []
  const updated: string[] = []
  const failed: string[] = []

  let teamIds: readonly number[] = staffTeamIds ?? []
  let keptExisting = false
  if (staffTeamIds === null) {
    try {
      teamIds = await existingFeedbackBaseTeamIds(client, org)
      keptExisting = true
    } catch (err) {
      log.warn(
        "could not read the current bypass list either; skipping the feedback-base ruleset",
        { org, err },
      )
      return {
        status: "warning",
        message: `${org}: could not read classroom staff teams; the feedback-base ruleset was left unchanged. Re-run setup once the classroom50 repository is readable.`,
        created,
        updated,
        failed: [RULESET_NAME_FEEDBACK_BASE],
      }
    }
  }

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

  for (const body of classroomRulesetBodies(teamIds)) {
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

  if (failed.length === 0 && keptExisting) {
    return {
      status: "warning",
      message: `${org}: could not read classroom staff teams, so the feedback-base bypass list was kept as is. Re-run setup once the classroom50 repository is readable.`,
      created,
      updated,
      failed,
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

// Every classroom's recorded staff team refs (teacher, hta, ta), read from
// each classroom.json in the config repo: the input repairRulesets and
// checkRulesets need. Only canonical refs count: classroom.json is writable by
// head TAs and these refs steer owner-run writes (team visibility, ruleset
// bypass), so a `teams.<role>` entry naming any other team (the student team,
// an invite team, a typo) is logged and dropped. A missing config repo (fresh
// org) yields []. Any other failure, including one unreadable classroom.json,
// throws: a shorter list would rebuild a shorter bypass list, so callers must
// fall back to what is already on the ruleset instead.
export async function collectStaffTeams(
  client: GitHubClient,
  org: string,
): Promise<StaffTeamRef[]> {
  const byId = new Map<number, StaffTeamRef>()
  await forEachClassroom(
    client,
    org,
    // Fail closed: any read failure means the caller must not rebuild.
    (_classroom, err) => {
      throw err
    },
    (classroom, json) => {
      for (const role of STAFF_ROLES) {
        const ref = json.teams?.[role]
        if (!ref) continue
        if (!isCanonicalStaffTeamRef(classroom, role, ref)) {
          log.warn("classroom.json names a non-canonical staff team; ignored", {
            org,
            classroom,
            role,
            slug: ref.slug,
          })
          continue
        }
        byId.set(ref.id, { id: ref.id, slug: ref.slug })
      }
    },
  )
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

// A classroom.json `teams.<role>` ref is trusted only when it names the team
// Classroom 50 itself creates for that classroom and role. Mirrors the CLI's
// configrepo.IsCanonicalStaffTeamRef.
export function isCanonicalStaffTeamRef(
  classroom: string,
  role: StaffRole,
  ref: { id?: unknown; slug?: unknown },
): boolean {
  return (
    Number.isInteger(ref.id) &&
    (ref.id as number) > 0 &&
    ref.slug === classroomTeamSlug(classroom, role)
  )
}

// The audit-side input: ids only, no writes. Throws like collectStaffTeams.
export async function collectStaffTeamIds(
  client: GitHubClient,
  org: string,
): Promise<number[]> {
  return (await collectStaffTeams(client, org)).map((t) => t.id)
}

// Make every staff team a valid bypass actor (GitHub rejects a `secret` team)
// and return the LIVE ids to hand repairRulesets. Teams created by an older
// release were secret; the PATCH here is the one-time upgrade. Ids come from
// GitHub, not classroom.json, so a team re-created under the same slug is
// exempted rather than its dead predecessor; a team that is gone is left out
// so the PUT can't 422 on it. A rate limit propagates (the caller must not
// rebuild the list from a partial pass); any other per-team failure is logged
// and that team left out, where the audit keeps flagging it.
export async function prepareStaffTeams(
  client: GitHubClient,
  org: string,
  teams: readonly StaffTeamRef[],
): Promise<number[]> {
  const ids: number[] = []
  await mapWithConcurrency(teams, 4, async (team) => {
    try {
      const existing = await client.request<{ id: number; privacy?: string }>(
        `/orgs/${org}/teams/${team.slug}`,
      )
      if (existing.privacy !== STAFF_TEAM_PRIVACY) {
        await client.request(`/orgs/${org}/teams/${team.slug}`, {
          method: "PATCH",
          body: { privacy: STAFF_TEAM_PRIVACY },
        })
      }
      if (existing.id !== team.id) {
        log.warn(
          "staff team id drifted from classroom.json; using the live id",
          {
            org,
            team: team.slug,
            recorded: team.id,
            live: existing.id,
          },
        )
      }
      ids.push(existing.id)
    } catch (err) {
      if (err instanceof GitHubAPIError) {
        if (err.isRateLimited) throw err
        if (err.isNotFound) {
          log.warn("staff team recorded in classroom.json no longer exists", {
            org,
            team: team.slug,
          })
          return
        }
      }
      log.warn("could not make staff team visible for the ruleset bypass", {
        org,
        team: team.slug,
        err,
      })
    }
  })
  return ids.sort((a, b) => a - b)
}

// The repair-side input: collect, make visible, return live ids. Resolves to
// null when the classroom list can't be read, so repairRulesets keeps the
// bypass list it finds rather than rebuilding a shorter one.
export async function collectBypassStaffTeamIds(
  client: GitHubClient,
  org: string,
): Promise<number[] | null> {
  try {
    return await prepareStaffTeams(
      client,
      org,
      await collectStaffTeams(client, org),
    )
  } catch (err) {
    log.warn(
      "could not read classroom staff teams; keeping the current bypass list",
      {
        org,
        err,
      },
    )
    return null
  }
}

// The Team actors currently on the installed feedback-base ruleset, whatever
// their mode (empty when not installed). repairRulesets' fallback input when
// the classroom list can't be read.
async function existingFeedbackBaseTeamIds(
  client: GitHubClient,
  org: string,
): Promise<number[]> {
  const existing = await listOrgRulesets(client, org)
  const id = existing.get(RULESET_NAME_FEEDBACK_BASE)
  if (id === undefined) return []
  const current = await client.request<OrgRulesetWithActors>(
    `/orgs/${org}/rulesets/${id}`,
  )
  return (current.bypass_actors ?? [])
    .filter((a) => a.actor_type === "Team")
    .map((a) => a.actor_id)
}
