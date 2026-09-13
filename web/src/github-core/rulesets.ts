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
import { ClassroomConfigError, forEachClassroom } from "./configRepoReads"
import { liveTeamId } from "./queries/teamReads"
import { STAFF_TEAM_PRIVACY, type GitHubTeam } from "./types"
import { GitHubAPIError } from "./errors"
import type { LocalizedMessage } from "@/types/localizedMessage"
import { FEEDBACK_BASE_BRANCH } from "@/util/feedbackPr"
import { CONFIG_REPO } from "@/util/configRepo"
import { classroomTeamSlug } from "@/util/teamSlug"
import { STAFF_ROLES } from "@/types/classroom"
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
  return [submissionHistoryBody(), feedbackBaseBody(staffTeamIds)]
}

// Locks the default branch's history: non_fast_forward blocks force-push,
// deletion blocks delete, neither blocks a normal fast-forward submit.
export function submissionHistoryBody(): OrgRulesetBody {
  return {
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
    rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
  }
}

// Locks the feedback branch: `update` restricts pushes and merges to the
// bypass actors (owners and staff teams), `deletion` blocks delete. Creation
// stays allowed so accept or the runner can land the branch once. Also the
// body the incremental bypass-list update PUTs.
export function feedbackBaseBody(
  staffTeamIds: readonly number[],
): OrgRulesetBody {
  return {
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
    rules: [{ type: "update" }, { type: "deletion" }],
  }
}

type OrgRuleset = { id: number; name: string }

type OrgRulesetWithActors = OrgRuleset & {
  bypass_actors?: RulesetBypassActor[]
}

const RULESET_NAMES = [
  RULESET_NAME_SUBMISSION_HISTORY,
  RULESET_NAME_FEEDBACK_BASE,
] as const

const isExemptOwner = (a: RulesetBypassActor) =>
  a.actor_type === "OrganizationAdmin" && a.bypass_mode === "exempt"
const isExemptTeam = (a: RulesetBypassActor) =>
  a.actor_type === "Team" && a.bypass_mode === "exempt"

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

// What the org has today: which classroom rulesets exist, and the feedback-base
// lock's bypass list when it does. One read shared by the audit, the repair
// fallback, and the incremental update (mirrors Go's feedbackBaseActors).
type RulesetState = {
  existing: Map<string, number>
  feedback: { id: number; actors: RulesetBypassActor[] } | null
}

async function readRulesetState(
  client: GitHubClient,
  org: string,
): Promise<RulesetState> {
  const existing = await listOrgRulesets(client, org)
  const id = existing.get(RULESET_NAME_FEEDBACK_BASE)
  if (id === undefined) return { existing, feedback: null }
  const current = await client.request<OrgRulesetWithActors>(
    `/orgs/${org}/rulesets/${id}`,
  )
  return { existing, feedback: { id, actors: current.bypass_actors ?? [] } }
}

// Pure judgment: enforced only when both classroom rulesets are present and
// the feedback-base lock's bypass list is exactly what we'd install: owners
// exempt, every expected staff team exempt, nothing else. A missing or `always`
// staff entry leaves staff unable to merge feedback PRs; a foreign actor is a
// hole in the lock. Both are what Fix it (repairRulesets) rebuilds.
function judgeRulesets(
  state: RulesetState,
  expectedStaffTeamIds: readonly number[],
): CheckVerdict {
  const missing = RULESET_NAMES.filter((name) => !state.existing.has(name))
  if (missing.length > 0 || state.feedback === null) {
    return {
      state: "unenforced",
      detail: {
        key: "orgSettings.audit.detail.rulesetsMissing",
        params: { names: missing.join(", ") },
      },
    }
  }
  const { actors } = state.feedback
  if (!actors.some(isExemptOwner)) {
    return {
      state: "unenforced",
      detail: { key: "orgSettings.audit.detail.rulesetOwnerNotExempt" },
    }
  }
  const exempt = new Set(actors.filter(isExemptTeam).map((a) => a.actor_id))
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
  const expected = new Set(expectedStaffTeamIds)
  const unexpected = actors.filter(
    (a) =>
      !isExemptOwner(a) &&
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
}

const STAFF_TEAMS_UNREADABLE: CheckVerdict = {
  state: "unreadable",
  detail: { key: "orgSettings.audit.detail.rulesetStaffTeamsUnreadable" },
}

// A read failure is retryable unless one classroom.json is itself unparsable:
// that stays broken until someone fixes the file, so the verdict names it
// instead of asking the teacher to try again.
function staffTeamsUnreadable(err: unknown): CheckVerdict {
  if (err instanceof ClassroomConfigError) {
    return {
      state: "unreadable",
      detail: {
        key: "orgSettings.audit.detail.rulesetClassroomInvalid",
        params: { classroom: err.classroom },
      },
    }
  }
  return STAFF_TEAMS_UNREADABLE
}

// The audit's one-call entry. The expected-team read and the ruleset read are
// independent, so they run in parallel; a collector failure becomes unreadable,
// never a green verdict against an empty expectation.
export async function auditRulesets(
  client: GitHubClient,
  org: string,
): Promise<CheckVerdict> {
  const [expected, state] = await Promise.all([
    expectedStaffTeamIds(client, org),
    readRulesetState(client, org).then(
      (s) => s,
      (err: unknown) => ({ error: err }),
    ),
  ])
  if ("error" in expected) return staffTeamsUnreadable(expected.error)
  if ("error" in state)
    return { state: "unreadable", detail: readFailedDetail(state.error) }
  return judgeRulesets(state, expected.ids)
}

export type RulesetsRepairResult = {
  status: "complete" | "warning"
  // Why a warning: the staff-team read failed (kept the current list, or left
  // the feedback lock alone), the ruleset listing failed, or a write was
  // refused.
  reason?: "staff_teams_unreadable" | "list_failed" | "apply_failed"
  // Whether a retry could succeed: every failed read, and a write GitHub
  // refused with a rate limit or 5xx. A 403/422 is a policy block and stays
  // non-transient so the UI can say so.
  transient?: boolean
  // Diagnostic (logs, tests). The setup board renders `detail` when present.
  message: string
  detail?: LocalizedMessage
  created: string[]
  updated: string[]
  failed: string[]
}

// A refused write that a retry could still land. Anything that is not a
// GitHub response (a dropped connection) counts too: offering a retry is
// harmless, while pinning "needs manual setup" after one blip is not.
function isTransientFailure(err: unknown): boolean {
  return err instanceof GitHubAPIError ? err.isTransient : true
}

// repairRulesets: reconcile both rulesets — PUT over an existing one (by id),
// else POST to create. staffTeamIds are every classroom's staff team ids, so
// the PUT rebuilds the feedback-base bypass list from scratch (a team deleted
// out of band drops off). null means the staff teams could not be read: the
// Team actors already on the ruleset are kept, or, when those can't be read
// either, the feedback-base ruleset is left untouched, and the result is a
// warning; a transient failure never wipes staff exemptions. Submission-history
// is reconciled in every case. Warn-and-continue on any single failure (init
// never fails on a ruleset error), mirroring the CLI's orgrules.Reconcile.
export async function repairRulesets(
  client: GitHubClient,
  org: string,
  staffTeamIds: readonly number[] | null,
): Promise<RulesetsRepairResult> {
  const created: string[] = []
  const updated: string[] = []
  const failed: string[] = []

  let bodies = classroomRulesetBodies(staffTeamIds ?? [])
  let fallback: LocalizedMessage | undefined
  if (staffTeamIds === null) {
    try {
      bodies = classroomRulesetBodies(
        await existingFeedbackBaseTeamIds(client, org),
      )
      fallback = {
        key: "orgSettings.steps.rulesets.staffTeamsKept",
        params: { org },
      }
    } catch (err) {
      log.warn(
        "could not read the current bypass list either; leaving the feedback-base ruleset unchanged",
        { org, err },
      )
      bodies = [submissionHistoryBody()]
      fallback = {
        key: "orgSettings.steps.rulesets.feedbackLockLeftUnchanged",
        params: { org },
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
      reason: "list_failed",
      transient: true,
      message: `${org}: could not list org rulesets; apply Feedback PR branch protections manually.`,
      created,
      updated,
      failed: [...RULESET_NAMES],
    }
  }

  let retryable = true
  for (const body of bodies) {
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
      if (!isTransientFailure(err)) retryable = false
    }
  }

  if (failed.length > 0) {
    return {
      status: "warning",
      reason: "apply_failed",
      transient: retryable,
      message: `${org}: some org rulesets could not be applied (${failed.join(", ")}); review them in org settings → rules.`,
      created,
      updated,
      failed,
    }
  }
  if (fallback !== undefined) {
    return {
      status: "warning",
      reason: "staff_teams_unreadable",
      transient: true,
      message: `${org}: could not read classroom staff teams (${fallback.key})`,
      detail: fallback,
      created,
      updated,
      failed,
    }
  }
  return {
    status: "complete",
    message: `${org}: org rulesets reconciled.`,
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
  const { feedback } = await readRulesetState(client, org)
  if (feedback === null) {
    log.warn("feedback-base ruleset not installed; staff team bypass skipped", {
      org,
    })
    return false
  }
  const remove = new Set(change.remove ?? [])
  const exempt = new Set(
    feedback.actors.filter(isExemptTeam).map((a) => a.actor_id),
  )
  const keep = [...exempt].filter((teamId) => !remove.has(teamId))
  const missing = (change.add ?? []).filter((teamId) => !exempt.has(teamId))
  const dropping = [...exempt].some((teamId) => remove.has(teamId))
  if (feedback.actors.some(isExemptOwner) && missing.length === 0 && !dropping)
    return true
  await client.request(`/orgs/${org}/rulesets/${feedback.id}`, {
    method: "PUT",
    body: feedbackBaseBody([...keep, ...missing]),
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
// knows. Run before the team delete. Takes ids the caller just minted (the
// create rollback); a delete flow uses revokeClassroomStaffTeams instead.
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

// Best-effort: drop the given classrooms' staff teams from the feedback-base
// bypass list by resolving each canonical slug to the live team, so the
// recorded `teams` block (head-TA-writable, and absent for a team a role flow
// created without recording it) never decides which id is dropped. Run before
// the team deletes.
export async function revokeClassroomStaffTeams(
  client: GitHubClient,
  org: string,
  classrooms: readonly string[],
): Promise<void> {
  const slugs = classrooms.flatMap((classroom) =>
    STAFF_ROLES.map((role) => classroomTeamSlug(classroom, role)),
  )
  const ids: number[] = []
  await mapWithConcurrency(slugs, 4, async (slug) => {
    try {
      const id = await liveTeamId(client, org, slug)
      if (id !== null) ids.push(id)
    } catch (err) {
      log.warn("could not look up a staff team to drop it from the lock", {
        org,
        slug,
        err,
      })
    }
  })
  await revokeStaffTeams(client, org, ids)
}

// The canonical staff team slugs (teacher, hta, ta) of every classroom in the
// config repo. The slug, not classroom.json, identifies a classroom's staff
// team: it is what every writer creates, what a role flow that never recorded
// a `teams` block still produced, and what a head-TA-editable ref can't
// redirect. A slug that is another classroom's student team (`ml`'s TA slug
// when a classroom `ml-ta` exists) is left out: that team is a roster,
// whatever an older release granted it. A missing config repo (fresh org)
// yields []. Any other failure, including one unreadable classroom.json,
// throws: a shorter list would rebuild a shorter bypass list, so callers fall
// back to what is already on the ruleset instead.
export async function collectStaffTeamSlugs(
  client: GitHubClient,
  org: string,
): Promise<string[]> {
  const classrooms: string[] = []
  await forEachClassroom(
    client,
    org,
    (_classroom, err) => {
      throw err
    },
    (classroom) => {
      classrooms.push(classroom)
    },
  )
  const known = new Set(classrooms)
  return classrooms.flatMap((classroom) =>
    STAFF_ROLES.filter((role) => !known.has(`${classroom}-${role}`)).map(
      (role) => classroomTeamSlug(classroom, role),
    ),
  )
}

type OrgTeamListing = Pick<GitHubTeam, "id" | "slug" | "privacy">

// One paginated read of the teams that hold a grant on the org's `classroom50`
// config repo, keyed by slug: the set of teams Classroom 50 owns (see
// mutations/teams.ts AdoptGuard for why the grant is the proof). Strict on
// purpose, unlike queries/teamReads.listRepoTeams, which swallows failures: a
// failure here must not read as "no teams", or the bypass list is rebuilt
// empty. A missing config repo (fresh org) is the one 404 that means that.
async function listConfigRepoTeamsBySlug(
  client: GitHubClient,
  org: string,
): Promise<Map<string, OrgTeamListing>> {
  let teams: OrgTeamListing[]
  try {
    teams = await paginateAll<OrgTeamListing>(
      client,
      (page) =>
        `/repos/${encodeURIComponent(org)}/${CONFIG_REPO}/teams?per_page=100&page=${page}`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return new Map()
    throw err
  }
  return new Map(teams.map((t) => [t.slug, t]))
}

// The live staff teams behind the slugs; a slug with no team in the listing (a
// role never staffed, or a team at the slug Classroom 50 did not create) is
// simply absent.
function resolveStaffTeams(
  slugs: readonly string[],
  teams: ReadonlyMap<string, OrgTeamListing>,
): OrgTeamListing[] {
  return slugs.flatMap((slug) => {
    const t = teams.get(slug)
    return t ? [t] : []
  })
}

// Make every live staff team a valid bypass actor (GitHub rejects a `secret`
// team; the PATCH is the one-time upgrade for teams an older release created)
// and return their ids for repairRulesets. Ids come from GitHub, so a team
// re-created under the same slug is exempted rather than its dead
// predecessor. A listing failure or rate limit propagates (the caller must not
// rebuild the list from a partial pass); a per-team PATCH failure is logged
// and that team left out, since a secret team can't be an actor anyway and
// the audit keeps flagging it.
export async function prepareStaffTeams(
  client: GitHubClient,
  org: string,
  slugs: readonly string[],
): Promise<number[]> {
  const teams = resolveStaffTeams(
    slugs,
    await listConfigRepoTeamsBySlug(client, org),
  )
  const ids: number[] = []
  await mapWithConcurrency(teams, 4, async (team) => {
    if (team.privacy !== STAFF_TEAM_PRIVACY) {
      try {
        await client.request(`/orgs/${org}/teams/${team.slug}`, {
          method: "PATCH",
          body: { privacy: STAFF_TEAM_PRIVACY },
        })
      } catch (err) {
        if (err instanceof GitHubAPIError && err.isRateLimited) throw err
        log.warn("could not make staff team visible for the ruleset bypass", {
          org,
          team: team.slug,
          err,
        })
        return
      }
    }
    ids.push(team.id)
  })
  return ids.sort((a, b) => a - b)
}

// The repair-side input: collect, make visible, return live ids. Resolves to
// null when the classrooms or the org's teams can't be read, so repairRulesets
// keeps the bypass list it finds rather than rebuilding a shorter one.
export async function collectBypassStaffTeamIds(
  client: GitHubClient,
  org: string,
): Promise<number[] | null> {
  try {
    return await prepareStaffTeams(
      client,
      org,
      await collectStaffTeamSlugs(client, org),
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

// The audit-side input: the ids the bypass list should hold, read without
// writing anything (a still-secret team counts as expected; Fix it upgrades
// it). The error is returned, not swallowed, so the verdict can tell a
// retryable read failure from a broken classroom.json.
async function expectedStaffTeamIds(
  client: GitHubClient,
  org: string,
): Promise<{ ids: number[] } | { error: unknown }> {
  try {
    const [slugs, teams] = await Promise.all([
      collectStaffTeamSlugs(client, org),
      listConfigRepoTeamsBySlug(client, org),
    ])
    return { ids: resolveStaffTeams(slugs, teams).map((t) => t.id) }
  } catch (err) {
    log.warn("could not read classroom staff teams for the ruleset audit", {
      org,
      err,
    })
    return { error: err }
  }
}

// The Team actors currently on the installed feedback-base ruleset, whatever
// their mode (empty when not installed). repairRulesets' fallback input when
// the classroom list can't be read.
async function existingFeedbackBaseTeamIds(
  client: GitHubClient,
  org: string,
): Promise<number[]> {
  const { feedback } = await readRulesetState(client, org)
  return (feedback?.actors ?? [])
    .filter((a) => a.actor_type === "Team")
    .map((a) => a.actor_id)
}
