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

export type RepoPagesInfo = {
  html_url?: string
  cname?: string | null
  build_type?: "legacy" | "workflow" | null
  source?: { branch: string; path: string }
  status?: "built" | "building" | "errored" | null
  public?: boolean
}

// Why a Pages create was refused, for callers that fail open (accept, bulk):
// - plan: the repo is private and the plan has no private Pages (GitHub Free
//   for organizations). GitHub answers 422 or 403 mentioning upgrade/plan.
// - policy: the org blocks members from publishing Pages sites (403).
// - branch: `source.branch` does not exist in the repo yet (422).
// - access: the caller is not a repo admin, or the repo is invisible (404/403).
export type PagesEnableReason = "plan" | "policy" | "branch" | "access" | "unknown"

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
// by a PUT, so a student's or teacher's own later change survives). Any other
// failure is returned classified rather than thrown, so accept and the bulk
// action can fail open with a specific message.
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
    if (err instanceof GitHubAPIError && err.status === 409) {
      return { enabled: true, alreadyEnabled: true }
    }
    return { enabled: false, reason: classifyPagesEnableError(err), error: err }
  }
}

// GET /repos/{owner}/{repo}/pages. `null` when no site is configured (404);
// any other failure throws.
export async function getRepoPages(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoPagesInfo | null> {
  try {
    return await client.request<RepoPagesInfo>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return null
    throw err
  }
}
