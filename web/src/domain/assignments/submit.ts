import { SUBMISSION_TAG_PREFIX } from "@/github-core/queries/releaseRunReads"

// The canonical submission tag for a commit: submit/<UTC-timestamp>-<short-sha>.
// Byte-format-identical with the runner's tag-minting step and the CLI's
// contract.BuildSubmitTag; the short-SHA suffix prevents collisions when two
// submissions land in the same UTC second.
export function buildSubmitTag(sha: string, now: Date = new Date()): string {
  const ts = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(":", "-")
  return `${SUBMISSION_TAG_PREFIX}${ts}-${sha.slice(0, 7)}`
}
