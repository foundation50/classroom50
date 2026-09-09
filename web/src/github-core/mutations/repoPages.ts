import type { GitHubClient } from "../client"
import { GitHubAPIError, githubErrorMentions } from "../errors"
import {
  classifyApiError,
  forbidden,
  notFound,
  status,
  type ErrorRung,
} from "./classifyApiError"
import type { PagesCreateBody } from "@/util/repoPages"

export type { PagesCreateBody }

// Why a Pages create was refused, for callers that fail open (accept, bulk):
// - plan: the repo is private and the plan has no private Pages (GitHub Free
//   for organizations). GitHub answers 422 or 403 mentioning upgrade/plan.
// - policy: the org blocks members from publishing Pages sites (403).
// - branch: `source.branch` does not exist in the repo yet (422).
// - access: the caller is not a repo admin, or the repo is invisible (404/403).
export type PagesEnableReason =
  "plan" | "policy" | "branch" | "access" | "unknown"

const mentionsPlan = (err: GitHubAPIError) =>
  githubErrorMentions(err, "upgrade") ||
  githubErrorMentions(err, "make this repository public")

const mentionsBranch = (err: GitHubAPIError) =>
  githubErrorMentions(err, "branch")

const mentionsPolicy = (err: GitHubAPIError) =>
  githubErrorMentions(err, "not allowed") ||
  githubErrorMentions(err, "disabled") ||
  githubErrorMentions(err, "restrict")

// Order matters: the plan refusal can arrive as a 403 too, so it is tried
// before the generic policy/access rungs.
const PAGES_ENABLE_RUNGS: ErrorRung<PagesEnableReason>[] = [
  [(err) => status(422)(err) && mentionsBranch(err), "branch"],
  [mentionsPlan, "plan"],
  [(err) => forbidden(err) && mentionsPolicy(err), "policy"],
  [(err) => forbidden(err) || notFound(err), "access"],
]

export function classifyPagesEnableError(err: unknown): PagesEnableReason {
  return classifyApiError(err, PAGES_ENABLE_RUNGS, "unknown")
}

export type EnableRepoPagesResult =
  | { enabled: true; alreadyEnabled: boolean }
  | { enabled: false; reason: PagesEnableReason; error: unknown }

// Configure a repo's Pages site. 201 = created, 409 = a site already exists
// (treated as done: the existing configuration is left alone, never overwritten
// by a PUT, so a student's or teacher's own later change survives). A refusal
// is returned classified rather than thrown, so accept and the bulk action can
// fail open with a specific message. A rate limit is the one exception: it is
// rethrown, because it is not a refusal of THIS repo and a bulk fan-out must
// stop launching more writes on it (runBulkFanOut keys on the throw).
export async function enableRepoPages(
  client: GitHubClient,
  owner: string,
  repo: string,
  body: PagesCreateBody,
): Promise<EnableRepoPagesResult> {
  try {
    await client.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`,
      { method: "POST", body },
    )
    return { enabled: true, alreadyEnabled: false }
  } catch (err) {
    if (err instanceof GitHubAPIError) {
      if (err.status === 409) return { enabled: true, alreadyEnabled: true }
      if (err.isRateLimited) throw err
    }
    return { enabled: false, reason: classifyPagesEnableError(err), error: err }
  }
}
