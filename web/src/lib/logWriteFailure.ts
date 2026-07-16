import type { Logger } from "@/lib/logger"
import { GitHubAPIError } from "@/github-core/errors"

// Console-only trace for a failed GitHub write. Single-sources the two-branch
// shape the create/edit call sites hand-copy: a GitHubAPIError logs its
// status/requestId under `message`; anything else is an unexpected non-API error
// worth recording. The MutationCache already records the API failure, so the
// GitHubAPIError branch does NOT set `record`.
export function logWriteFailure(
  log: Logger,
  err: unknown,
  message: string,
): void {
  if (err instanceof GitHubAPIError) {
    log.error(message, { status: err.status, requestId: err.requestId })
  } else {
    log.error("non-GitHub API error", { err, record: true })
  }
}
