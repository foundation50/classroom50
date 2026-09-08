import type { DetectedSubmission } from "@/domain/assignments/submissionDetection"

// The shapes the submissions UI consumes, derived from scores.json by
// hooks/useGetScores and read by domain/submissions/dashboard. Here rather than
// in the hook so the pure dashboard logic depends downward only.

// The flattened row the submissions UI renders: one per student repo, with the
// latest submission's fields, credited usernames, and count. Keeps the legacy
// field names so table/CSV consumers stay simple.
export type SubmissionRow = {
  usernames: string[]
  owner: string
  // Team-mode crediting: the group's GitHub Team slug when the collector
  // recorded one (scores-v1 `team_slug`); absent otherwise.
  teamSlug?: string
  datetime: string
  commit: string
  release: string
  review: string
  score: number
  "max-score": number
  submissionCount: number
  late?: boolean
  // Last (re-)graded instant of the latest submission (mirrors submissions[0]).
  gradedAt?: string
  // The entry carries a teacher override (`override: true` in scores.json): the
  // latest score was set/frozen by hand rather than (only) autograded. The
  // table marks it so a hand-entered grade is distinguishable from an
  // autograded one. Mirrors the collector's per-entry override flag.
  overridden?: boolean
  // For an overridden entry, the score/max of the newest REAL (non-synthesized)
  // submission beneath the override — the autograded value the score reverts to
  // when the override is cleared. Absent when the override has no real history
  // (a grade entered on a repo with no collected submission), or when the entry
  // isn't overridden. Read-only; the effective displayed grade is still
  // `score`/`max-score` above.
  autogradedScore?: number
  autogradedMax?: number
  // A row with a submission the collector recorded as present but not graded
  // (no score yet) — rendered as "submitted, not yet collected" rather than a
  // 0/0 score. Excluded from graded stats/average and the CSV score column.
  pending?: boolean
  // The row's `submissionCount` was raised above the collected history by live
  // release data: the student pushed more `submit/*` releases than scores.json
  // ingested, so the newest aren't graded yet. Only set on a snapshot-backed row
  // (a live-only row is wholly `pending`).
  staleCount?: boolean
  // When `staleCount`, the publish time of the newest live `submit/*` release —
  // the true latest push, later than the graded `datetime`. Owner-only.
  liveLatestAt?: string
  // The detection overlay's per-submission breakdown (tag-mode tags or
  // branch-mode commits), so the expanded history can list tagged submissions
  // with a jump-to-tag link. Grades never come from here; owner-only.
  detectedEntries?: DetectedSubmission[]
  // Per-attempt history, newest first; the summary fields above mirror submissions[0].
  submissions: SubmissionAttempt[]
}

// One past submission, flattened for the per-row history timeline.
export type SubmissionAttempt = {
  datetime: string
  commit: string
  release: string
  score: number
  "max-score": number
  late?: boolean
  gradedAt?: string
  submittedBy?: string
}

export type NormalizedScores = {
  schema: string
  submissions: Record<string, SubmissionRow[]>
  // Slug -> per-bucket `collected_at` stamp, where present. More precise than
  // the org-wide workflow-run timestamp: a scoped collect refreshes only its
  // own bucket, so only that bucket's stamp moves.
  collectedAt: Record<string, string>
  // Slug -> collected DETECTED submitters: repos with submissions but no graded
  // entry (see AssignmentBucket.detected). Separate from `submissions` because
  // these carry no score and must never be fed to a grade consumer (stats, CSV,
  // ScoreBadge, passing filters). The key is absent until a collect has walked
  // the bucket, which lets the UI tell "nobody submitted" apart from "never
  // collected".
  detected: Record<string, DetectedSubmitter[]>
}

// One detected submitter as the UI consumes it. Grade-free by construction.
export type DetectedSubmitter = {
  owner: string
  usernames: string[]
  count: number
  datetime?: string
  late?: boolean
}
