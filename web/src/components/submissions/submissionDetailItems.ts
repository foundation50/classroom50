import {
  detectedTagHref,
  detectedTagLabel,
  jumpableTagEntries,
  resolveSubmissionMode,
} from "@/domain/assignments/submissionDetection"
import type { DetectedSubmission } from "@/domain/assignments/submissionDetection"
import { repoTagsUrl } from "@/util/orgUrl"
import type { SubmissionMode } from "@/types/classroom"
import type { SubmissionDetailItem } from "@/components/submissions/SubmissionDetailsModal"

// Translator shape both submission views already thread into their item
// builders — kept narrow so these helpers stay view-facing without importing
// react-i18next.
type Translate = (key: string, opts?: Record<string, unknown>) => string

// Map detected tag/tag-group entries to details-modal items. Shared by the
// teacher table and the student page (byte-identical before extraction): an
// exact tag shows its stripped label and jumps to its tree; a glob group shows
// its pattern + match count and jumps to its representative commit. The commit
// side is intentionally NOT shared — the two views read different sources.
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
