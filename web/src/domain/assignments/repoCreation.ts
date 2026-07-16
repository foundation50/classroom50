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
}): Promise<AcceptRepoCreationResult> {
  const { client, templateOwner, templateRepo, owner, name, fallbackBranch } =
    params

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
  // provisionAcceptedRepo), all in one commit.
  return await createEmptyAssignmentRepo({
    client,
    owner,
    name,
    branch: fallbackBranch,
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
async function createEmptyAssignmentRepo(params: {
  client: GitHubClient
  owner: string
  name: string
  branch: string
}): Promise<AcceptRepoCreationResult> {
  const { client, owner, name, branch } = params
  let repo: GitHubRepo

  try {
    // metadata + workflow must land in ONE commit so the accept marker and the
    // autograde workflow share the runner's Feedback-PR baseline. auto_init
    // gives the initial commit to build that single tree commit on; committing
    // .classroom50.yaml alone first would split them and skew the baseline.
    repo = await client.request<GitHubRepo>(`/orgs/${owner}/repos`, {
      method: "POST",
      body: {
        name,
        private: true,
        auto_init: true,
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
  pass_threshold?: number
  tests: AssignmentTestDraft[]
}
export async function createAssignmentWithConflictRetry(
  client: GitHubClient,
  input: CreateAssignmentInput,
) {
  return withGitConflictRetry(() => createAssignment(client, input))
}
