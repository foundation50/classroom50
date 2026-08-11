import type { GitHubClient } from "@/github-core/client"
import type { GitHubRepo } from "@/github-core/types"
import type {
  RepoPermission,
  RepoFeatures,
  SubmissionMode,
  Grading,
} from "@/types/classroom"
import { GitHubAPIError } from "@/github-core/errors"
import { getRepo } from "@/github-core/repoReads"
import { DEFAULT_BRANCH } from "@/util/configRepo"
import type { AssignmentTestDraft } from "@/util/assignmentTests"
import {
  forkParentRestrictedError,
  inOrgTemplateError,
  isOrgRepoCreationDenied,
  orgRepoCreationDeniedError,
  outOfOrgTemplateError,
} from "@/util/templateAccessError"
import { log } from "./accessPrimitives"
import { withGitConflictRetry } from "../classrooms"
import { createAssignment } from "./createEdit"

const extractTemplate = (template: string) => {
  if (!/\//.test(template)) return template
  return template.split("/")?.[1] ?? template
}

// Best-effort probe: return the fork's PARENT org login when `owner/repo` is a
// fork of a repo owned by a DIFFERENT org than `classroomOrg`, else undefined.
// Used only on an in-org template generate failure to tell a cross-org-fork 403
// (parent org's OAuth-App restriction, issue #468) from a plain missing-team-
// grant 403. getRepo is 404-tolerant (null), and any read error here is
// swallowed so the caller falls back to the message-parse path below.
//
// NOTE: in the exact #468 case the parent org has revoked the app, so this read
// is gated by that SAME restriction and 403s too — hence it can't be the only
// signal (see parentOrgFromRestrictionMessage, which reads GitHub's 403 body
// and works even when the fork read is blocked).
async function crossOrgForkParentOwner(
  client: GitHubClient,
  owner: string,
  repo: string,
  classroomOrg: string,
): Promise<string | undefined> {
  let templateRepo: GitHubRepo | null
  try {
    templateRepo = await getRepo(client, owner, repo)
  } catch {
    return undefined
  }
  if (!templateRepo?.fork) return undefined
  const parentOwner = templateRepo.parent?.full_name?.split("/")[0]
  if (!parentOwner) return undefined
  if (parentOwner.toLowerCase() === classroomOrg.toLowerCase()) return undefined
  return parentOwner
}

// GitHub's OAuth-App-restriction 403 body names the restricting org in
// backticks: "...the `some-org` organization has enabled OAuth App access
// restrictions...". For a cross-org fork template the restriction is anchored to
// the fork's UPSTREAM org, so the named org is the parent — and this signal
// survives even when a follow-up repo read is itself blocked (issue #468).
// Returns the named org only when it differs from the classroom org (a match
// means it's an ordinary same-org restriction, not the cross-org-fork case).
const OAUTH_RESTRICTION_ORG = /`([^`]+)`\s+organization has enabled OAuth App/i

function parentOrgFromRestrictionMessage(
  message: string | undefined,
  classroomOrg: string,
): string | undefined {
  const named = message?.match(OAUTH_RESTRICTION_ORG)?.[1]
  if (!named) return undefined
  if (named.toLowerCase() === classroomOrg.toLowerCase()) return undefined
  return named
}

export async function createAssignmentRepo(params: {
  client: GitHubClient
  templateOwner?: string
  templateRepo?: string
  owner: string
  name: string
  fallbackBranch: string
  // empty_repo assignment: create bare (auto_init false, no commits). The
  // mutual exclusion with template is enforced at write time, so template
  // params are never set alongside this.
  bare?: boolean
  // Templated only: copy ALL of the template's branches (not just the default)
  // on POST /generate. Ignored for the bare/template-less paths (no generate).
  includeAllBranches?: boolean
}): Promise<AcceptRepoCreationResult> {
  const {
    client,
    templateOwner,
    templateRepo,
    owner,
    name,
    fallbackBranch,
    bare,
    includeAllBranches = false,
  } = params

  const cleanTemplateRepo = templateRepo
    ? extractTemplate(templateRepo)
    : undefined

  if (templateOwner && cleanTemplateRepo) {
    try {
      const repo = await client.request<GitHubRepo>(
        `/repos/${templateOwner}/${cleanTemplateRepo}/generate`,
        {
          method: "POST",
          body: {
            owner,
            name,
            private: true,
            include_all_branches: includeAllBranches,
          },
        },
      )

      return {
        kind: "generated",
        repo,
      }
    } catch (err) {
      if (!(err instanceof GitHubAPIError)) {
        throw err
      }

      if (err.status === 422) {
        const existing = await client.request<GitHubRepo>(
          `/repos/${owner}/${name}`,
        )

        return {
          kind: "already-accepted",
          repo: existing,
        }
      }

      // Don't fall back to an empty repo — it looks "accepted" but has no
      // template content and can't be regenerated. A rate-limit also surfaces
      // as 403, so rethrow it before treating 403/404 as a template problem.
      if (err.isRateLimited) {
        throw err
      }
      // The destination org refusing the create is independent of where the
      // template lives, so it is classified before the in-org/out-of-org split —
      // which would otherwise blame the template for a destination problem
      // (issue #413). `owner` is the destination org, not templateOwner.
      if (isOrgRepoCreationDenied(err)) {
        throw orgRepoCreationDeniedError(owner, err.status, err.message)
      }
      if (err.isForbidden || err.isNotFound) {
        const inOrg = templateOwner.toLowerCase() === owner.toLowerCase()
        // An in-org template that still 403/404s on generate can be a fork of a
        // repo in ANOTHER org: generate copies the fork's own objects fine, so
        // the block is the PARENT org's OAuth-App restriction, not this org or a
        // missing team grant (issue #468). "Re-run setup" can't fix that, so
        // name the parent org and its approval as the remedy. Two signals, in
        // order of reliability: GitHub's own 403 body names the restricting org
        // (survives even when a follow-up read is blocked — the common case),
        // then a repo probe for the fork's parent when the body didn't say. Only
        // on the in-org branch — an out-of-org template already gets a
        // parent-agnostic remedy.
        if (inOrg) {
          const parentOwner =
            parentOrgFromRestrictionMessage(err.message, owner) ??
            (await crossOrgForkParentOwner(
              client,
              templateOwner,
              cleanTemplateRepo,
              owner,
            ))
          if (parentOwner) {
            throw forkParentRestrictedError(
              parentOwner,
              templateOwner,
              cleanTemplateRepo,
              err.status,
              err.message,
            )
          }
        }
        // Tripwire for GitHub rewording the destination-org 403: the match stops
        // firing, students silently get the template message again, and the tests
        // can't catch it (they assert our own fixture). A 404 is not evidence of
        // that, so it stays out of the warn.
        if (err.isForbidden) {
          log.warn("accept: repo create 403 fell through to template blame", {
            org: owner,
            templateOwner,
            inOrg,
            githubMessage: err.message,
          })
        }
        throw inOrg
          ? inOrgTemplateError(
              templateOwner,
              cleanTemplateRepo,
              err.status,
              err.message,
            )
          : outOfOrgTemplateError(
              templateOwner,
              cleanTemplateRepo,
              err.status,
              err.message,
            )
      }

      // Any other status is a real failure too — don't mask it with an empty repo.
      throw err
    }
  }

  // No template specified — create an empty starter repo. auto_init seeds the
  // initial commit; the metadata + shim land in the downstream tree commit (see
  // provisionAcceptedRepo), all in one commit. An empty_repo assignment skips
  // auto_init too: the repo stays commitless until the student's first push.
  return await createEmptyAssignmentRepo({
    client,
    owner,
    name,
    branch: fallbackBranch,
    autoInit: !bare,
  })
}

type AcceptRepoCreationResult =
  | {
      kind: "generated"
      repo: GitHubRepo
    }
  | {
      kind: "already-accepted"
      repo: GitHubRepo
    }
  | {
      kind: "fallback-empty"
      repo: GitHubRepo
      branch: string
    }
  | {
      // empty_repo assignment: created with auto_init false, so the repo has
      // NO commits and no branches — the caller must not attempt any commit.
      kind: "bare"
      repo: GitHubRepo
    }
async function createEmptyAssignmentRepo(params: {
  client: GitHubClient
  owner: string
  name: string
  branch: string
  // false = empty_repo assignment: no initial commit at all. The repo stays
  // commitless until the student's first push.
  autoInit?: boolean
}): Promise<AcceptRepoCreationResult> {
  const { client, owner, name, branch, autoInit = true } = params
  let repo: GitHubRepo

  try {
    // metadata + workflow must land in ONE commit so the accept marker and the
    // autograde workflow share the runner's Feedback-PR baseline. auto_init
    // gives the initial commit to build that single tree commit on; committing
    // .classroom50.yaml alone first would split them and skew the baseline.
    // (The bare empty_repo path passes autoInit false and commits nothing.)
    repo = await client.request<GitHubRepo>(`/orgs/${owner}/repos`, {
      method: "POST",
      body: {
        name,
        private: true,
        auto_init: autoInit,
      },
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 422) {
      const existing = await client.request<GitHubRepo>(
        `/repos/${owner}/${name}`,
      )

      return {
        kind: "already-accepted",
        repo: existing,
      }
    }

    if (err instanceof GitHubAPIError) {
      // Template-less and empty_repo assignments hit this path, where the same
      // destination-org refusal used to rethrow raw and degrade to generic text.
      if (isOrgRepoCreationDenied(err)) {
        throw orgRepoCreationDeniedError(owner, err.status, err.message)
      }
      if (err.isForbidden) {
        // Same tripwire as the templated path above.
        log.warn("accept: repo create 403 fell through unclassified", {
          org: owner,
          githubMessage: err.message,
        })
      }
    }

    throw err
  }

  // Bare (empty_repo) create: the repo has no commits and no branches, so any
  // default_branch GitHub reports is the org default setting, not a real ref —
  // return the dedicated kind so no caller trusts it or attempts a commit.
  if (!autoInit) {
    return { kind: "bare", repo }
  }

  // Commit onto the repo's real default branch (GitHub picks it for an
  // auto_init repo); fall back to the requested branch, then DEFAULT_BRANCH.
  const targetBranch = repo.default_branch || branch || DEFAULT_BRANCH
  return {
    kind: "fallback-empty",
    repo: {
      ...repo,
      default_branch: targetBranch,
    },
    branch: targetBranch,
  }
}

export type CreateAssignmentInput = {
  name: string
  description: string
  template_repo: string
  due_date: string
  // Release date (datetime-local wall-clock or ""); normalized like due_date.
  available_from_date: string
  mode: string
  slug: string
  classroom: string
  org: string
  max_group_size: number
  feedback_pr?: boolean
  // Truly bare student repos (no auto-init, no control files, autograding and
  // Feedback PR off). Mutually exclusive with template/tests/feedback_pr/
  // allowed_files/release_assets/pass_threshold; immutable after creation
  // (edit rejects a change). Mirrors the CLI's --empty-repo.
  empty_repo?: boolean
  // Teacher-supplied CI on a templated assignment: accept commits no autograde
  // shim. Mutually exclusive with empty_repo, a non-default autograder, and the
  // grading-adjacent fields; permits a template and the Feedback PR. Immutable
  // after creation. Mirrors the CLI's no_autograder field.
  no_autograder?: boolean
  // Built-in autograder on an otherwise-empty, template-less repo: accept
  // initializes the repo with only the marker + default shim (no README) and it
  // autogrades. Mutually exclusive with empty_repo, a template, and
  // no_autograder. Immutable after creation. Mirrors the CLI's init_shim field.
  init_shim?: boolean
  // Copy all template branches at generate (POST /generate include_all_branches).
  // Requires a template; mutually exclusive with empty_repo/init_shim. Mutable.
  // Mirrors the CLI's include_all_branches field.
  include_all_branches?: boolean
  runs_on?: string
  container_image?: string
  container_user?: string
  runtime_python?: string
  runtime_node?: string
  runtime_java?: string
  runtime_go?: string
  runtime_rust?: string
  // Raw comma/space-separated apt packages; parsed to string[] on save.
  runtime_apt?: string
  setup_command?: string
  // Web transport state for the synthesized leading setup test. This is not an
  // assignments.json field.
  setup_timeout?: number
  allowed_files?: string
  release_assets: string
  pass_threshold?: number
  // Accept-time role for the enrolled student on their own repo. Undefined =
  // the mode default (push individual / admin group). buildAssignmentEntry
  // omits it when it equals the default and clamps group up to admin.
  student_permission?: RepoPermission
  // When the autograder fires. Undefined or "every-push" = the wire default
  // (buildAssignmentEntry omits it); "tag" = the shim grades only submit/* tag
  // pushes. Mutually exclusive with empty_repo. Mirrors the CLI's
  // --submission-mode.
  submission_mode?: SubmissionMode
  // Teacher-named milestone tag patterns that also trigger grading (union
  // with the always-on submit/* namespace in the shim). Empty/undefined =
  // none (buildAssignmentEntry omits the key). Mutually exclusive with
  // empty_repo. Mirrors the CLI's --submission-tag.
  submission_tags?: string[]
  // The teacher's grading intent (off/auto/manual) with a manual max_points.
  // Undefined reads as "auto" (today's behavior). Orthogonal to the autograding
  // tri-state; buildAssignmentEntry omits the block when it resolves to plain
  // auto with no max. The mode is immutable after creation (edit rejects a
  // change). Mirrors the CLI's grading object.
  grading?: Grading
  // Per-assignment repo feature overrides (tri-state per key: undefined =
  // inherit, true = force on, false = force off). buildAssignmentEntry omits
  // the block when no key is set; accept resolves + applies it at fresh create.
  repo_features?: RepoFeatures
  tests: AssignmentTestDraft[]
  // Whether the write path may attempt the owner-only template read-grant
  // (addRepositoryToTeam). Set from useCanAttemptTemplateGrant at the call site
  // (true unless the org role is a confirmed non-owner). When false the save
  // skips the grant and returns an owner-required warning instead of firing the
  // owner-only call — the grant is best-effort and an owner re-affirms it later.
  // GitHub is the real enforcer regardless.
  canGrantTemplateAccess?: boolean
}
export async function createAssignmentWithConflictRetry(
  client: GitHubClient,
  input: CreateAssignmentInput,
) {
  return withGitConflictRetry(() => createAssignment(client, input))
}
