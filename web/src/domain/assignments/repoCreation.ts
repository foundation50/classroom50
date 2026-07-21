import type { GitHubClient } from "@/github-core/client"
import type { GitHubRepo } from "@/github-core/types"
import { GitHubAPIError } from "@/github-core/errors"
import { DEFAULT_BRANCH } from "@/util/configRepo"
import type { AssignmentTestDraft } from "@/util/assignmentTests"
import {
  inOrgTemplateError,
  outOfOrgTemplateError,
} from "@/util/templateAccessError"
import { withGitConflictRetry } from "../classrooms"
import { createAssignment } from "./createEdit"

const extractTemplate = (template: string) => {
  if (!/\//.test(template)) return template
  return template.split("/")?.[1] ?? template
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
}): Promise<AcceptRepoCreationResult> {
  const {
    client,
    templateOwner,
    templateRepo,
    owner,
    name,
    fallbackBranch,
    bare,
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
            include_all_branches: false,
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
      if (err.isForbidden || err.isNotFound) {
        const inOrg = templateOwner.toLowerCase() === owner.toLowerCase()
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
  allowed_files?: string
  release_assets: string
  pass_threshold?: number
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
