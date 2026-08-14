import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { jsonFileQuery } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_QUERIES } from "@/lib/logScopes"
import type { DetectedSubmission } from "@/domain/assignments/submissionDetection"

const log = logger.scope(LOG_SCOPE_QUERIES)

// Canonical <classroom>/scores.json shape (classroom50/scores/v1), written by
// the CLI's collect_scores.py — the GUI is a pure consumer. Keyed by slug →
// bucket `{ type, entries[] }`; an entry is one repo's gradebook record (keyed
// by `owner`) with its submission history, newest first.
type SubmissionRecord = {
  schema: string
  classroom: string
  assignment_type: "individual" | "group"
  owner: string
  submission: string
  commit: string
  release: string
  review: string
  datetime: string
  score: number
  "max-score": number
  tests: unknown[]
  late?: boolean
  // The wall-clock instant this submission was last (re-)graded. Distinct from
  // `datetime` (fixed submission time = commit committer date): a teacher
  // regrade refreshes `graded_at` but never moves `datetime`. Optional — absent
  // on results graded before the field existed.
  graded_at?: string
  submitted_by?: {
    username: string
    id?: number | null
  }
}

type ScoreEntry = {
  owner: string
  member_usernames?: string[]
  submissions: SubmissionRecord[]
  override?: boolean
}

type AssignmentBucket = {
  type: "individual" | "group"
  entries: ScoreEntry[]
  // Per-bucket freshness stamp written by collect_scores.py: the UTC instant
  // collection last walked THIS assignment (absent on files written before the
  // field existed).
  collected_at?: string
}

type ScoresSchema = {
  schema: string
  assignments: Record<string, AssignmentBucket>
}

// The flattened row the submissions UI renders: one per student repo, with the
// latest submission's fields, credited usernames, and count. Keeps the legacy
// field names so table/CSV consumers stay simple.
export type SubmissionRow = {
  usernames: string[]
  owner: string
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
}

// Collapse a bucket's entries to one row each (latest submission first).
// `member_usernames` credits the whole group; individual entries fall back to
// `owner`. Sorted defensively in case a hand-edit reordered submissions.
function bucketToRows(bucket: AssignmentBucket): SubmissionRow[] {
  // A hand-edited or partial scores.json bucket can lack `entries`; degrade to
  // no rows instead of throwing in the react-query select (which would blank
  // the whole submissions view).
  if (bucket && !Array.isArray(bucket.entries)) {
    log.warn("scores.json bucket has no entries array; degrading to no rows")
  }
  const entries = Array.isArray(bucket?.entries) ? bucket.entries : []
  return entries
    .filter(
      (entry) =>
        entry &&
        Array.isArray(entry.submissions) &&
        entry.submissions.length > 0,
    )
    .map((entry) => {
      const sorted = entry.submissions
        .slice()
        .sort(
          (a, b) =>
            new Date(b.datetime).getTime() - new Date(a.datetime).getTime(),
        )
      // For a teacher-overridden entry, the displayed grade must be the manual
      // override record, not whichever submission sorts newest by datetime — a
      // real autograded submission's datetime is the student-controllable
      // committer date and could be future-dated above the override. Prefer the
      // synthesized manual record (submission tag `submit/manual-*`) when the
      // entry is overridden; the writer also clamps its datetime to sort first,
      // so this is defense-in-depth for entries written before that clamp.
      const overrideRecord =
        entry.override === true
          ? sorted.find((s) => s.submission.startsWith("submit/manual-"))
          : undefined
      const latest = overrideRecord ?? sorted[0]

      // The autograded value beneath an override: the newest real (non-manual)
      // submission. Used by the override editor to show what clearing reverts
      // to. Undefined when the entry isn't overridden or has no real history.
      const autograded =
        entry.override === true
          ? sorted.find((s) => !s.submission.startsWith("submit/manual-"))
          : undefined

      const usernames =
        entry.member_usernames && entry.member_usernames.length > 0
          ? entry.member_usernames
          : [entry.owner]

      return {
        usernames,
        owner: entry.owner,
        datetime: latest.datetime,
        commit: latest.commit,
        release: latest.release,
        review: latest.review,
        score: latest.score,
        "max-score": latest["max-score"],
        submissionCount: entry.submissions.length,
        late: latest.late,
        gradedAt: latest.graded_at,
        overridden: entry.override === true,
        autogradedScore: autograded?.score,
        autogradedMax: autograded?.["max-score"],
        submissions: sorted.map((s) => ({
          datetime: s.datetime,
          commit: s.commit,
          release: s.release,
          score: s.score,
          "max-score": s["max-score"],
          late: s.late,
          gradedAt: s.graded_at,
          submittedBy: s.submitted_by?.username,
        })),
      }
    })
}

// Map the canonical nested shape to a slug -> rows map. Returns `null` for a
// missing/empty file so callers can distinguish "no data yet" from "no
// submissions".
export function normalizeScores(
  data: ScoresSchema | undefined,
): NormalizedScores | undefined {
  if (!data) return undefined

  const submissions: Record<string, SubmissionRow[]> = {}
  const collectedAt: Record<string, string> = {}
  for (const [slug, bucket] of Object.entries(data.assignments ?? {})) {
    submissions[slug] = bucketToRows(bucket)
    if (typeof bucket?.collected_at === "string" && bucket.collected_at) {
      collectedAt[slug] = bucket.collected_at
    }
  }

  return { schema: data.schema, submissions, collectedAt }
}

const useGetScores = (
  org: string | undefined,
  classroom: string | undefined,
) => {
  const client = useGitHubClient()
  return useQuery({
    ...jsonFileQuery<ScoresSchema>(
      client,
      org ?? "",
      CONFIG_REPO,
      `${classroom ?? ""}/scores.json`,
    ),
    select: normalizeScores,
    // Freshness is surfaced explicitly (the DataFreshness widget + manual
    // Refresh), so we don't refetch on every tab refocus — that fired a
    // scores.json re-read on each focus. A 60s staleTime still serves cache
    // across normal navigation and refetches when genuinely stale.
    staleTime: 60 * 1000,
  })
}

export default useGetScores
