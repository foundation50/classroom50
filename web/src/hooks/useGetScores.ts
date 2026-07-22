import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { jsonFileQuery } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_QUERIES } from "@/lib/logScopes"

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
  // A live-only row: the student has a submit/* release the collector hasn't
  // ingested yet, so it carries presence (datetime/release) but no grade.
  // Rendered as "submitted, not yet collected" rather than a 0/0 score.
  pending?: boolean
  // The row's `submissionCount` was raised above the collected history by live
  // release data: the student has pushed more `submit/*` releases than
  // scores.json has ingested, so the newest submission(s) aren't graded yet.
  // The table hints this so a teacher knows to re-collect. Only set on a
  // snapshot-backed row (a live-only row is wholly `pending`).
  staleCount?: boolean
  // When `staleCount`, the publish time of the newest live `submit/*` release —
  // the true latest push, later than the graded `datetime`. Lets the table show
  // "latest push <time>, not yet graded" without moving the graded submission
  // time. Owner-only (only the owner's live fan-out runs).
  liveLatestAt?: string
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
      const latest = sorted[0]

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
  for (const [slug, bucket] of Object.entries(data.assignments ?? {})) {
    submissions[slug] = bucketToRows(bucket)
  }

  return { schema: data.schema, submissions }
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
