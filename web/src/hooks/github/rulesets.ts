// Web mirror of the CLI's org ruleset install (classroom50-cli init_repo.go
// ensureClassroomRulesets). Two org branch rulesets protect submission history
// and lock the Feedback PR base branch. Reconciled by name: PUT over an existing
// ruleset, else POST to create. Definitions must match the CLI exactly — a
// divergence is a parity bug.

import type { GitHubClient } from "./client"
import { paginateAll } from "./queries"
import type { CheckVerdict } from "./orgChecks"
import { readFailedDetail } from "./orgChecks"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_GITHUB_SETUP } from "@/lib/logScopes"

const log = logger.scope(LOG_SCOPE_GITHUB_SETUP)

const FEEDBACK_BASE_BRANCH = "feedback"

export const RULESET_NAME_SUBMISSION_HISTORY =
  "classroom50-protect-submission-history"
export const RULESET_NAME_FEEDBACK_BASE = "classroom50-feedback-base-lock"

type RefPatternCondition = {
  include: string[]
  exclude: string[]
}

type RulesetBypassActor = {
  actor_id: number
  actor_type: string
  bypass_mode: string
}

type RulesetRule = { type: string }

type OrgRulesetBody = {
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

// OrganizationAdmin (actor_id 1) is the org-owner role — the teacher — so they
// can merge the Feedback PR and force-push/delete in a pinch, while students
// (maintain, no bypass) cannot.
const ADMIN_BYPASS: RulesetBypassActor[] = [
  { actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" },
]

const ALL_REPOS: RefPatternCondition = { include: ["~ALL"], exclude: [] }

export function classroomRulesetBodies(): OrgRulesetBody[] {
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
      bypass_actors: ADMIN_BYPASS,
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
      bypass_actors: ADMIN_BYPASS,
      // update restricts pushes/merges to bypass actors; deletion blocks delete.
      rules: [{ type: "update" }, { type: "deletion" }],
    },
  ]
}

type OrgRuleset = { id: number; name: string }

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

// checkRulesets: enforced only when both classroom rulesets are present.
export async function checkRulesets(
  client: GitHubClient,
  org: string,
): Promise<CheckVerdict> {
  try {
    const existing = await listOrgRulesets(client, org)
    const missing = classroomRulesetBodies()
      .map((r) => r.name)
      .filter((name) => !existing.has(name))
    return {
      state: missing.length === 0 ? "enforced" : "unenforced",
      detail:
        missing.length === 0 ? undefined : `missing: ${missing.join(", ")}`,
    }
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
// else POST to create. Warn-and-continue on any single failure (init never fails
// on a ruleset error), mirroring the CLI's ensureClassroomRulesets.
export async function repairRulesets(
  client: GitHubClient,
  org: string,
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
      failed: classroomRulesetBodies().map((r) => r.name),
    }
  }

  for (const body of classroomRulesetBodies()) {
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
