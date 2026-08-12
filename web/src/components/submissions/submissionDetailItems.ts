import {
  detectedTagHref,
  detectedTagLabel,
  jumpableTagEntries,
  resolveSubmissionMode,
} from "@/domain/assignments/submissionDetection"
import type { DetectedSubmission } from "@/domain/assignments/submissionDetection"
import { repoTagsUrl } from "@/util/orgUrl"
import { safeHttpUrl } from "@/util/url"
import { formatSubmissionDateTime } from "@/util/formatDate"
import type { SubmissionMode } from "@/types/classroom"
import type { SubmissionDetailItem } from "@/components/submissions/SubmissionDetailsModal"

// Translator shape both submission views already thread into their item
// builders — kept narrow so these helpers stay view-facing without importing
// react-i18next.
type Translate = (key: string, opts?: Record<string, unknown>) => string

// A normalized push (default-branch commit) submission, mode-agnostic across the
// two views: the teacher maps its collected scores.json attempts to this shape,
// the student maps its live default-branch commits. `commitHref`/`releaseHref`
// are raw (possibly unsafe) URLs — the builder guards them.
export type PushSubmission = {
  key: string
  commitHref?: string | null
  datetime?: string
  releaseHref?: string | null
}

// Map detected tag/tag-group entries to details-modal items. Shared by the
// teacher table and the student page (byte-identical before extraction): an
// exact tag shows its stripped label and jumps to its tree; a glob group shows
// its pattern + match count and jumps to its representative commit.
export function tagDetailItems(
  entries: DetectedSubmission[],
  org: string,
  repo: string,
  t: Translate,
): SubmissionDetailItem[] {
  return jumpableTagEntries(entries).map((entry) => ({
    key: `${entry.kind}-${entry.label}`,
    kind: "tag",
    label:
      entry.kind === "tag-group"
        ? t("submissions.type.tagGroupCount", {
            pattern: entry.label,
            count: entry.count,
          })
        : detectedTagLabel(entry.label),
    href: detectedTagHref(entry, org, repo),
  }))
}

// Map normalized push submissions to details-modal items, newest first (the
// caller supplies them newest-first, matching both the collected history and
// GitHub's default commit order). Numbered #N…#1 so the newest reads highest.
export function commitDetailItems(
  commits: PushSubmission[],
  t: Translate,
): SubmissionDetailItem[] {
  return commits.map((commit, i) => ({
    key: commit.key,
    kind: "commit",
    label: t("submissions.details.pushEntry", { number: commits.length - i }),
    sublabel: commit.datetime
      ? formatSubmissionDateTime(commit.datetime)
      : undefined,
    href: safeHttpUrl(commit.commitHref),
    releaseHref: safeHttpUrl(commit.releaseHref),
  }))
}

// The one type-aware item builder both views use: tag entries in tag mode, push
// submissions otherwise. Each view feeds only its own mode's source (a
// branch-mode repo has no tags; a tag-mode repo's commits aren't the submission
// unit), so the unused side is simply empty.
export function buildSubmissionDetailItems(
  {
    tags,
    commits,
  }: {
    tags: DetectedSubmission[]
    commits: PushSubmission[]
  },
  mode: SubmissionMode | undefined,
  org: string,
  repo: string,
  t: Translate,
): SubmissionDetailItem[] {
  return resolveSubmissionMode(mode) === "tag"
    ? tagDetailItems(tags, org, repo, t)
    : commitDetailItems(commits, t)
}

// The details modal's no-submissions copy + repository link, keyed by mode:
// tag mode points at the tags page (submissions arrive as tags), every-push at
// the default branch (`repoHref`). Shared so both views word the empty state
// identically. `repoHref` is passed already-resolved so each caller keeps its
// own href guarding.
export function submissionEmptyState(
  mode: SubmissionMode | undefined,
  org: string,
  repo: string,
  repoHref: string | undefined,
  t: Translate,
): { emptyLabel: string; emptyLinkLabel: string; emptyLinkHref?: string } {
  const isTag = resolveSubmissionMode(mode) === "tag"
  return {
    emptyLabel: t(
      isTag
        ? "submissions.details.emptyTag"
        : "submissions.details.emptyEveryPush",
    ),
    emptyLinkLabel: t(
      isTag
        ? "submissions.details.emptyLinkTags"
        : "submissions.details.emptyLinkDefaultBranch",
    ),
    emptyLinkHref: isTag ? repoTagsUrl(org, repo) : repoHref,
  }
}
