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
