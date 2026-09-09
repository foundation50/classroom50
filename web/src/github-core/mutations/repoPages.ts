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

// Why a Pages create was refused, for callers that fail open:
// - plan: a private repo on a plan without private Pages (GitHub Free for
//   organizations); GitHub says to upgrade or make the repo public.
// - policy: the org blocks members from publishing Pages sites (403).
// - branch: `source.branch` does not exist in the repo yet (422).
// - access: not a repo admin, or the repo is invisible (403/404).
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

// Order matters: the plan refusal can arrive as a 403, so it precedes the
// generic policy/access rungs.
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

// Configure a repo's Pages site. 201 = created; 409 = a site already exists and
// is left alone (never overwritten, so a later manual change survives). A
// refusal is returned classified rather than thrown so callers fail open with a
// specific message. A rate limit is rethrown: it is not a refusal of this repo,
// and runBulkFanOut stops launching writes only on a throw.
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
