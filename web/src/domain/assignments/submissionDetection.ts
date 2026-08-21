import type { GitHubCommit, GitHubTag } from "@/github-core/types"
import { SUBMISSION_TAG_PREFIX } from "@/github-core/queries/releaseRunReads"
import { matchesSubmissionTag } from "@/util/submissionTags"
import { repoTreeAtRefUrl } from "@/util/orgUrl"
import {
  commitSubject,
  FEEDBACK_OPEN_COMMIT_MESSAGE,
  shimUpdateCommitMessage,
} from "@/util/commit"
import { SUBMISSION_MODES, type SubmissionMode } from "@/types/classroom"

// Pure derivation for the submission-detection subsystem (KTD6/KTD7): turn raw
// repo state (default-branch commits, git tags) plus the submission definition
// into detected submissions. No React, no fetch — the fan-out hook (U8) and the
// merge layer (U10) consume these. Grades never come from here; detection only
// reveals which submissions exist and how they group.

// One detected submission (or grouped set, for a glob). `count` is the number of
// underlying commits/tags it represents (1 for a single commit or exact tag; N
// for a glob group). `label` names it for the UI (a tag name, a glob pattern, or
// a commit sha); `sha` points at the underlying commit when known. `datetime`
// is the submission's ISO time when the source carries one: branch-mode
// commits always do, canonical submit/* tags encode it in the name, and
// milestone tags get it filled by a per-commit lookup in the fan-out.
export type DetectedSubmission = {
  kind: "commit" | "tag" | "tag-group"
  label: string
  count: number
  sha?: string
  datetime?: string
}

// A glob pattern uses any Actions tag-filter metacharacter; an exact pattern is
// a literal tag name. Only globs GROUP their matches into one submission set.
export function isGlobPattern(pattern: string): boolean {
  return /[*?+[\]]/.test(pattern)
}

// The subjects of the commits the tool authors onto a student repo's DEFAULT
// BRANCH for its own bookkeeping: the empty commit that opens the Feedback PR
// at accept time and the submission-mode shim retrofit. Neither can ever be
// graded — both carry `[skip ci]`, and the runner skips them anyway — so
// counting one shows a submission no run, tag or Release can follow. Taken
// from the writers' own strings so the two can't drift; ANY further such
// writer must be added here. Deliberately not "anything carrying `[skip ci]`":
// a student can write that too, and their push is still a submission, it just
// wasn't graded. The student's own `[Classroom 50] Submit <slug>` carries the
// prefix but is not in this set, so submit-flow work keeps counting.
const TOOL_COMMIT_SUBJECTS: ReadonlySet<string> = new Set(
  [
    FEEDBACK_OPEN_COMMIT_MESSAGE,
    ...SUBMISSION_MODES.map((mode) => shimUpdateCommitMessage(mode)),
  ].map(commitSubject),
)

// `baselineSha` is the oldest commit touching the .classroom50.yaml marker; a
// null baseline (no marker, e.g. a bare repo) excludes nothing. Exported so the
// student's own view counts the identical set (useGetMyPushSubmissions) instead
// of re-deriving it. Anything not in that set still counts — an unrecognized
// commit is a submission, never a silent skip.
export function submissionCommits(
  commits: GitHubCommit[],
  baselineSha: string | null,
): GitHubCommit[] {
  return commits.filter(
    (c) =>
      c.sha !== baselineSha &&
      !TOOL_COMMIT_SUBJECTS.has(commitSubject(c.commit.message)),
  )
}

// Branch mode: every submission commit past the baseline is one submission
// (R6, KTD7). Commits arrive newest-first (GitHub's default order), preserved.
export function detectBranchSubmissions(
  commits: GitHubCommit[],
  baselineSha: string | null,
): DetectedSubmission[] {
  return submissionCommits(commits, baselineSha).map((c) => ({
    kind: "commit" as const,
    label: c.sha.slice(0, 7),
    count: 1,
    sha: c.sha,
    datetime: c.commit.committer?.date ?? c.commit.author?.date,
  }))
}

// The submission time encoded in a canonical submit/<UTC-ts>-<short-sha> tag
// name (buildSubmitTag replaces the timestamp's colons with dashes to keep the
// ref valid). The one tag-mode time that costs no extra API call — the
// lightweight tags list carries no dates. Undefined for milestone/malformed
// names; those fall back to a per-commit date lookup in the fan-out.
export function submitTagDatetime(tagName: string): string | undefined {
  const m = /^submit\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z-/.exec(
    tagName,
  )
  if (!m) return undefined
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`
  return Number.isFinite(new Date(iso).getTime()) ? iso : undefined
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
      // A group's time and representative sha come from its newest member by
      // encoded submit/* timestamp; without any parseable name (a milestone
      // glob) keep the list's first match and leave the time for the
      // per-commit lookup.
      const newest = newestByEncodedTime(matches)
      detected.push({
        kind: "tag-group",
        label: pattern,
        count: matches.length,
        sha: (newest ?? matches[0]).commit.sha,
        datetime: newest ? submitTagDatetime(newest.name) : undefined,
      })
    } else {
      for (const t of matches) {
        detected.push({
          kind: "tag",
          label: t.name,
          count: 1,
          sha: t.commit.sha,
          datetime: submitTagDatetime(t.name),
        })
      }
    }
  }

  return detected
}

// The tag with the newest submit/*-encoded timestamp, or null when none of the
// names encode one.
function newestByEncodedTime(tags: GitHubTag[]): GitHubTag | null {
  let best: GitHubTag | null = null
  let bestMs = -Infinity
  for (const t of tags) {
    const iso = submitTagDatetime(t.name)
    if (!iso) continue
    const ms = new Date(iso).getTime()
    if (ms > bestMs) {
      best = t
      bestMs = ms
    }
  }
  return best
}

// The total number of submissions a detected set represents — the sum of each
// entry's count (a glob group counts its matches). This is the value the merge
// layer compares against the snapshot count (max wins, KTD6).
export function detectedSubmissionCount(
  detected: DetectedSubmission[],
): number {
  return detected.reduce((sum, d) => sum + d.count, 0)
}

// The newest detected submission time, or null when no entry carries one.
// Robust against callers that don't preserve newest-first order; unparseable
// datetimes are ignored.
export function latestDetectedAt(
  detected: DetectedSubmission[] | undefined,
): string | null {
  let best: string | null = null
  let bestMs = -Infinity
  for (const d of detected ?? []) {
    if (!d.datetime) continue
    const ms = new Date(d.datetime).getTime()
    if (Number.isFinite(ms) && ms > bestMs) {
      best = d.datetime
      bestMs = ms
    }
  }
  return best
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
// "N tagged submissions" vs "N commits on the default branch". Callers pass
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
