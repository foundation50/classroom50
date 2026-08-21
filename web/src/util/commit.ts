// Commit-message prefix for every tool-authored commit the GUI makes, so a
// teacher or student can tell them apart in the repo history. Kept byte-identical
// with the CLI's cli/shared/contract (CommitPrefix / PrefixCommit) and the
// skeleton collect-scores.yaml workflow — no compile-time link across the three,
// so update every copy in lockstep.

export const COMMIT_PREFIX = "[Classroom 50]"

// prefixCommit prepends COMMIT_PREFIX, producing "[Classroom 50] <message>".
// Any trailing "(gh ... )" provenance hint a caller includes is preserved.
export function prefixCommit(message: string): string {
  return `${COMMIT_PREFIX} ${message}`
}

// A commit's subject: the first line of its message, trimmed.
export function commitSubject(message: string): string {
  return message.split("\n")[0].trim()
}

// The two commits the tool authors onto a STUDENT repo's default branch for its
// own bookkeeping. They live here, next to the prefix, for the same reason Go
// keeps them in cli/shared/contract rather than in the command packages: the
// writers and the submissions page (which must not count either as student
// work) both need them, and neither should import the other.
//
// The `[skip ci]` body line is load-bearing on both: it keeps the autograde
// shim from running on a commit with nothing to grade. Byte-mirrors of
// contract.FeedbackOpenCommitMessage and contract.ShimUpdateCommitMessage,
// pinned on the Go side by contract_test.go.
export const FEEDBACK_OPEN_COMMIT_MESSAGE = `${prefixCommit(
  "Open Feedback PR (gh student accept)",
)}\n\n[skip ci]`

export function shimUpdateCommitMessage(mode: "every-push" | "tag"): string {
  return (
    prefixCommit(`Update autograder trigger to ${mode} (submission-mode)`) +
    "\n\n[skip ci]"
  )
}
