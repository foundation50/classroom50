import type { GitHubCommit, GitHubTag } from "@/github-core/types"
import { SUBMISSION_TAG_PREFIX } from "@/github-core/queries/releaseRunReads"
import { matchesSubmissionTag } from "@/util/submissionTags"
import { repoTreeAtRefUrl } from "@/util/orgUrl"
import type { SubmissionMode } from "@/types/classroom"

// Pure derivation for the submission-detection subsystem (KTD6/KTD7): turn raw
// repo state (default-branch commits, git tags) plus the submission definition
// into detected submissions. No React, no fetch — the fan-out hook (U8) and the
// merge layer (U10) consume these. Grades never come from here; detection only
// reveals which submissions exist and how they group.

// One detected submission (or grouped set, for a glob). `count` is the number of
// underlying commits/tags it represents (1 for a single commit or exact tag; N
// for a glob group). `label` names it for the UI (a tag name, a glob pattern, or
// a commit sha); `sha` points at the underlying commit when known.
export type DetectedSubmission = {
  kind: "commit" | "tag" | "tag-group"
  label: string
  count: number
  sha?: string
}

// A glob pattern uses any Actions tag-filter metacharacter; an exact pattern is
// a literal tag name. Only globs GROUP their matches into one submission set.
export function isGlobPattern(pattern: string): boolean {
  return /[*?+[\]]/.test(pattern)
}

// Branch mode: every default-branch commit except the baseline counts as a
// submission (R6, KTD7). `baselineSha` is the oldest commit touching the
// .classroom50.yaml marker; a null baseline (no marker, e.g. a bare repo) counts
// every commit. Commits arrive newest-first (GitHub's default order), preserved.
export function detectBranchSubmissions(
  commits: GitHubCommit[],
  baselineSha: string | null,
): DetectedSubmission[] {
  return commits
    .filter((c) => c.sha !== baselineSha)
    .map((c) => ({
      kind: "commit" as const,
      label: c.sha.slice(0, 7),
      count: 1,
      sha: c.sha,
    }))
}

// Tag mode: for each configured pattern, an EXACT pattern yields one submission
// per matching tag; a GLOB pattern groups all its matching tags into a single
// submission set (R7). A tag matched by more than one pattern is attributed to
// the first pattern that claims it, so it is never double-counted.
export function detectTagSubmissions(
  tags: GitHubTag[],
  submissionTags: string[],
): DetectedSubmission[] {
  const detected: DetectedSubmission[] = []
  const claimed = new Set<string>()

  for (const pattern of submissionTags) {
    const matches = tags.filter(
      (t) => !claimed.has(t.name) && matchesSubmissionTag([pattern], t.name),
    )
    if (matches.length === 0) continue
    for (const t of matches) claimed.add(t.name)

    if (isGlobPattern(pattern)) {
      detected.push({
        kind: "tag-group",
        label: pattern,
        count: matches.length,
        sha: matches[0].commit.sha,
      })
    } else {
      for (const t of matches) {
        detected.push({
          kind: "tag",
          label: t.name,
          count: 1,
          sha: t.commit.sha,
        })
      }
    }
  }

  return detected
}

// The total number of submissions a detected set represents — the sum of each
// entry's count (a glob group counts its matches). This is the value the merge
// layer compares against the snapshot count (max wins, KTD6).
export function detectedSubmissionCount(
  detected: DetectedSubmission[],
): number {
  return detected.reduce((sum, d) => sum + d.count, 0)
}

// The entries that can be "jumped to" as a tag: branch-mode `commit` entries
// carry no tag, so both submission views filter them out before rendering jump
// links.
export function jumpableTagEntries(
  entries: DetectedSubmission[],
): DetectedSubmission[] {
  return entries.filter((e) => e.kind === "tag" || e.kind === "tag-group")
}

// The git ref a detected tag entry jumps to: an exact tag jumps to the tag name
// itself; a glob group has no single tag, so it jumps to its representative
// commit sha. Undefined when a group has no sha (defensive — detection always
// sets one). Callers build the tree URL with repoTreeAtRefUrl.
export function detectedTagRef(entry: DetectedSubmission): string | undefined {
  return entry.kind === "tag-group" ? entry.sha : entry.label
}

// The tree URL a detected tag entry jumps to, or undefined when it can't form a
// safe link. Both views share this so the jump target stays identical.
export function detectedTagHref(
  entry: DetectedSubmission,
  org: string,
  repo: string,
): string | undefined {
  const ref = detectedTagRef(entry)
  return ref ? repoTreeAtRefUrl(org, repo, ref) : undefined
}

// The submission mode resolved to its wire default: an absent mode is
// every-push (writers omit it). Both submission views key their type-aware
// wording off this.
export function resolveSubmissionMode(
  mode: SubmissionMode | undefined,
): SubmissionMode {
  return mode ?? "every-push"
}

// The i18n key for the "what counts as a submission" heading badge, keyed by
// mode. Single source so the teacher heading and the student page agree. The
// badge only describes what counts; whether it is graded is the separate
// autograding badge's job (see AutogradingBadge).
export function submissionModeBadgeKey(
  mode: SubmissionMode | undefined,
): string {
  return resolveSubmissionMode(mode) === "tag"
    ? "submissions.type.badgeTag"
    : "submissions.type.badgeEveryPush"
}

// The i18n (pluralized) key for a submission count, keyed by mode:
// "N tagged submissions" vs "N pushes to the default branch". Callers pass
// `{ count }` to t().
export function submissionModeCountKey(
  mode: SubmissionMode | undefined,
): string {
  return resolveSubmissionMode(mode) === "tag"
    ? "submissions.type.countTag"
    : "submissions.type.countEveryPush"
}

// A friendly display label for an exact detected tag: strip the canonical
// submit/ prefix so `submit/2026-...` reads as the timestamp; milestone tags
// are shown as-is. Groups are labeled by their pattern + count in the view
// (i18n), so this is only used for exact tags.
export function detectedTagLabel(label: string): string {
  return label.startsWith(SUBMISSION_TAG_PREFIX)
    ? label.slice(SUBMISSION_TAG_PREFIX.length)
    : label
}
