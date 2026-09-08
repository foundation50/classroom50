import { useQuery } from "@tanstack/react-query"

import { useGitHubClient } from "@/context/github/GitHubProvider"
import { jsonFileQuery } from "@/github-core/queries"
import { CONFIG_REPO } from "@/util/configRepo"
import { scoresFilePath } from "@/util/configRepoPaths"
import { logger } from "@/lib/logger"
import { LOG_SCOPE_QUERIES } from "@/lib/logScopes"
import type {
  DetectedSubmitter,
  NormalizedScores,
  SubmissionRow,
} from "@/domain/submissions/scores"

export type {
  DetectedSubmitter,
  NormalizedScores,
  SubmissionAttempt,
  SubmissionRow,
} from "@/domain/submissions/scores"

const log = logger.scope(LOG_SCOPE_QUERIES)

// Canonical <classroom>/scores.json shape (classroom50/scores/v1), written by
// the CLI's collect_scores.py — the GUI is a pure consumer. Keyed by slug →
// bucket `{ type, entries[] }`; an entry is one repo's gradebook record (keyed
// by `owner`) with its submission history, newest first.
type SubmissionRecord = {
  schema: string
  classroom: string
  assignment_type: "individual" | "group" | "team"
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
  // Team-mode crediting: the group's GitHub Team slug (scores-v1 `team_slug`).
  // Type only — ingestion tolerates its absence (a pre-team collector).
  team_slug?: string
  submissions: SubmissionRecord[]
  override?: boolean
}

type AssignmentBucket = {
  type: "individual" | "group" | "team"
  entries: ScoreEntry[]
  // Per-bucket freshness stamp written by collect_scores.py: the UTC instant
  // collection last walked THIS assignment (absent on files written before the
  // field existed).
  collected_at?: string
  // Presence/count records for repos with submissions but no graded entry: every
  // submitter of a no_autograder assignment (no submit/* release exists) and, for
  // an autograded one, repos with pushes the autograder hasn't published yet. An
  // owner is never in both lists. Never carries a score — see scores-v1's
  // detectedRecord.
  detected?: DetectedRecord[]
}

// One repo's detected (ungraded) submissions, written by collect_scores.py.
// Count/presence only, by construction.
type DetectedRecord = {
  owner: string
  count: number
  kind?: "commit" | "tag"
  latest_datetime?: string
  late?: boolean
  member_usernames?: string[]
}

type ScoresSchema = {
  schema: string
  assignments: Record<string, AssignmentBucket>
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
        ...(entry.team_slug ? { teamSlug: entry.team_slug } : {}),
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

// Normalize a bucket's detected records for the UI. Defensive like bucketToRows:
// a hand-edited file shouldn't blank the view. A record without a positive count
// is dropped — the collector omits non-submitters rather than writing 0, so the
// list is exactly the submitter set.
function bucketToDetected(records: DetectedRecord[]): DetectedSubmitter[] {
  return records
    .filter(
      (record) =>
        record &&
        typeof record.owner === "string" &&
        record.owner !== "" &&
        typeof record.count === "number" &&
        record.count > 0,
    )
    .map((record) => ({
      owner: record.owner,
      usernames:
        Array.isArray(record.member_usernames) &&
        record.member_usernames.length > 0
          ? record.member_usernames
          : [record.owner],
      count: record.count,
      datetime: record.latest_datetime,
      late: record.late,
    }))
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
  const detected: Record<string, DetectedSubmitter[]> = {}
  for (const [slug, bucket] of Object.entries(data.assignments ?? {})) {
    submissions[slug] = bucketToRows(bucket)
    if (typeof bucket?.collected_at === "string" && bucket.collected_at) {
      collectedAt[slug] = bucket.collected_at
    }
    if (Array.isArray(bucket?.detected)) {
      detected[slug] = bucketToDetected(bucket.detected)
    }
  }

  return { schema: data.schema, submissions, collectedAt, detected }
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
      scoresFilePath(classroom ?? ""),
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
