// Commit-message prefix for every tool-authored commit the GUI makes, so a
// teacher or student can tell them apart in the repo history. Kept byte-identical
// with the CLI's cli/shared/contract (CommitPrefix / PrefixCommit) and the
// skeleton collect-scores.yaml workflow — no compile-time link across the three,
// so update every copy in lockstep.

import type { SubmissionMode } from "@/types/classroom"

export const COMMIT_PREFIX = "[Classroom 50]"

// prefixCommit prepends COMMIT_PREFIX, producing "[Classroom 50] <message>".
// Any trailing "(gh ... )" provenance hint a caller includes is preserved.
export function prefixCommit(message: string): string {
  return `${COMMIT_PREFIX} ${message}`
}

// A commit's subject: the first line of its message, trimmed. Callers want the
// subject rather than the whole message because bodies carry noise they must
// not match on or display — the tool's `[skip ci]` marker lives in the body,
// and a timeline row has no space for one.
export function commitSubject(message: string): string {
  const newline = message.indexOf("\n")
  return (newline === -1 ? message : message.slice(0, newline)).trim()
}

// The two commits the tool authors onto a STUDENT repo's default branch for its
// own bookkeeping, plus the shim backfill. They live here, next to the prefix,
// for the same reason Go keeps them in cli/shared/contract rather than in the
// command packages: the writers and the submissions page (which must not count
// any of them as student work) both need them, and neither should import the
// other.
//
// The `[skip ci]` body line is load-bearing on all of them: it keeps the
// autograde shim from running on a commit with nothing to grade. Byte-mirrors
// of contract.FeedbackOpenCommitMessage, contract.ShimUpdateCommitMessage, and
// contract.ShimBackfillCommitMessage, pinned on the Go side by their tests.
export const FEEDBACK_OPEN_COMMIT_MESSAGE = `${prefixCommit(
  "Open Feedback PR (gh student accept)",
)}\n\n[skip ci]`

export function shimUpdateCommitMessage(mode: SubmissionMode): string {
  return (
    prefixCommit(`Update autograder trigger to ${mode} (submission-mode)`) +
    "\n\n[skip ci]"
  )
}

// The backfill commit (default shim and/or the missing marker) for a repo
// accepted while the built-in autograder was off. Its subject is a baseline
// contract: byte-mirror of contract.ShimBackfillCommitMessage (pinned by its Go
// test) and collect_scores.py's TOOL_COMMIT_SUBJECTS.
export const SHIM_BACKFILL_COMMIT_MESSAGE = `${prefixCommit(
  "Add autograde workflow (enable-autograder)",
)}\n\n[skip ci]`

// Whether a commit is the backfill's: subject compared exactly after trimming,
// body ignored. A marker that commit introduced must not anchor the baseline
// (see baselineSource). Mirror of contract.IsShimBackfillCommit.
export function isShimBackfillCommit(message: string): boolean {
  return commitSubject(message) === commitSubject(SHIM_BACKFILL_COMMIT_MESSAGE)
}
