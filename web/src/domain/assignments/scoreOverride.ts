import type { GitHubClient } from "@/github-core/client"
import { scoresFilePath } from "@/util/configRepoPaths"
import { withGitConflictRetry } from "../classrooms"
import {
  commitConfigRepoFiles,
  jsonFileEntry,
  readConfigRepoHead,
} from "../configRepoWrite"
import { readConfigJson } from "@/github-core/queries"

// A stored submission record inside scores.json (classroom50/result/v1 payload
// minus the bucket-key `assignment`). We only type the fields the override path
// reads or writes; unknown fields are preserved verbatim on read-modify-write.
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
  [key: string]: unknown
}

type ScoreEntry = {
  owner: string
  member_usernames?: string[]
  // Team-mode crediting: the group's GitHub Team slug (scores-v1 `team_slug`).
  team_slug?: string
  submissions: SubmissionRecord[]
  override?: boolean
  [key: string]: unknown
}

type AssignmentBucket = {
  type: "individual" | "group" | "team"
  entries: ScoreEntry[]
  // e.g. the collector's `collected_at` — preserved verbatim on RMW.
  [key: string]: unknown
}

type ScoresFile = {
  schema: "classroom50/scores/v1"
  assignments: Record<string, AssignmentBucket>
}

const SCORES_SCHEMA = "classroom50/scores/v1"
const RESULT_SCHEMA = "classroom50/result/v1"

export type SetScoreOverrideInput = {
  org: string
  classroom: string
  assignment: string
  // Repo owner login — the stable per-bucket key (individual student, group
  // founder, or the team repo's `group-<n>` owner segment). Case-insensitive
  // on match; stored as given for a new entry.
  owner: string
  // Group/team crediting for a new entry (individual entries omit it and are
  // credited to `owner`). Team rows credit LIVE team members. Ignored when
  // clearing.
  memberUsernames?: string[]
  assignmentType: "individual" | "group" | "team"
  // Team-mode: the group team's slug, recorded on a new entry (scores-v1
  // `team_slug`). Ignored for other modes and when clearing.
  teamSlug?: string
  // The teacher-entered score and its max (max >= 1). Ignored when clearing.
  score?: number
  maxPoints?: number
  // When true, remove the teacher override for this owner: drop the entry if it
  // has no real (autograder-collected) submissions, else strip `override` and
  // the synthesized record so the next collect refreshes it.
  clear?: boolean
}

export type SetScoreOverrideResult = {
  newCommitSha: string
}

// A synthesized submission record for a hand-entered/overridden score. It has no
// real submit/* release, so `submission`/`commit`/`release`/`review` carry
// stable placeholders that still satisfy scores-v1 (submission matches ^submit/;
// the rest are non-empty). Readers key off score/max-score/datetime, which are
// real. `graded_by` is deliberately NOT stored — the config-repo commit author
// is the authoritative, GitHub-authenticated "who".
//
// `sentinelIso` is the wall-clock stamp used only for the placeholder tag;
// `datetimeIso` is the record's sort key, clamped by the caller so the override
// always sorts as the newest submission (a real autograded submission's
// datetime is the student-controllable committer date and could otherwise be
// future-dated above the override — see editScoreOverride).
function synthesizeOverrideRecord(
  input: SetScoreOverrideInput,
  sentinelIso: string,
  datetimeIso: string,
): SubmissionRecord {
  const sentinel = `submit/manual-${sentinelIso.replace(/[:.]/g, "-")}`
  return {
    schema: RESULT_SCHEMA,
    classroom: input.classroom,
    assignment_type: input.assignmentType,
    owner: input.owner,
    submission: sentinel,
    commit: sentinel,
    release: sentinel,
    review: sentinel,
    datetime: datetimeIso,
    score: input.score ?? 0,
    "max-score": input.maxPoints ?? 0,
    tests: [],
  }
}

// True when this record is our synthesized manual override (its submission tag
// starts with the manual sentinel), not a real autograder result.
function isSynthesizedManual(record: SubmissionRecord): boolean {
  return (
    typeof record.submission === "string" &&
    record.submission.startsWith("submit/manual-")
  )
}

// Read scores.json at a ref, returning a normalized file (a scaffold when the
// file is absent — a fresh classroom may not have run collection yet).
async function readScoresFile(
  client: GitHubClient,
  org: string,
  classroom: string,
  ref: string,
): Promise<ScoresFile> {
  // Only a 404 scaffolds (never collected). readConfigJson rethrows anything
  // else, so a blip can't make the save overwrite the gradebook with a stub.
  const parsed = await readConfigJson<ScoresFile>(client, {
    org,
    path: scoresFilePath(classroom),
    ref,
    onMissing: () => ({ schema: SCORES_SCHEMA, assignments: {} }),
  })
  if (!parsed.assignments) parsed.assignments = {}
  return parsed
}

// Upsert (or clear) a teacher score override for one repo owner in scores.json,
// then commit it to the config repo. The entry is written with `override: true`
// so the CLI collector preserves it verbatim (collect_scores.py apply_updates
// skips override:true entries), which is what makes a manual grade — and an
// override of an autograded score — survive re-collection. The whole thing is
// wrapped in withGitConflictRetry so a race with a collect run (or
// another teacher) re-reads and retries transparently.
export async function editScoreOverride(
  client: GitHubClient,
  input: SetScoreOverrideInput,
): Promise<SetScoreOverrideResult> {
  const { org, classroom, assignment, owner } = input

  return withGitConflictRetry(async () => {
    const head = await readConfigRepoHead(client, org, classroom)
    const scores = await readScoresFile(client, org, classroom, head.headSha)
    const bucket: AssignmentBucket = scores.assignments[assignment] ?? {
      type: input.assignmentType,
      entries: [],
    }
    // Keep the bucket type in sync with the assignment mode.
    bucket.type = input.assignmentType

    const ownerKey = owner.trim().toLowerCase()
    const idx = bucket.entries.findIndex(
      (e) => (e.owner ?? "").trim().toLowerCase() === ownerKey,
    )
    const nowIso = new Date().toISOString().replace(/\.\d+Z$/, "Z")

    if (input.clear) {
      if (idx >= 0) {
        const entry = bucket.entries[idx]
        const realSubmissions = (entry.submissions ?? []).filter(
          (s) => !isSynthesizedManual(s),
        )
        if (realSubmissions.length > 0) {
          // Keep the real autograder history; drop the override so the next
          // collect refreshes it.
          const rest: ScoreEntry = { ...entry, submissions: realSubmissions }
          delete rest.override
          bucket.entries[idx] = rest
        } else {
          // No real submissions — the entry existed only for the override.
          bucket.entries.splice(idx, 1)
        }
      }
    } else {
      const existingEntry = idx >= 0 ? bucket.entries[idx] : undefined
      const realSubmissions = (existingEntry?.submissions ?? []).filter(
        (s) => !isSynthesizedManual(s),
      )
      // Clamp the override datetime to strictly after the newest existing
      // submission so the override always sorts as the latest row. A real
      // autograded submission's datetime is the student-controllable committer
      // date and can be future-dated; without this clamp bucketToRows (which
      // sorts by datetime desc) would show that autograded score under the
      // "Manual" badge. max(now, newest+1s).
      const newestExistingMs = realSubmissions.reduce((max, s) => {
        const ms = new Date(s.datetime).getTime()
        return Number.isFinite(ms) && ms > max ? ms : max
      }, 0)
      const overrideMs = Math.max(
        new Date(nowIso).getTime(),
        newestExistingMs + 1000,
      )
      const overrideIso = new Date(overrideMs)
        .toISOString()
        .replace(/\.\d+Z$/, "Z")
      const record = synthesizeOverrideRecord(input, nowIso, overrideIso)
      if (existingEntry) {
        // The override record leads (newest first); real history is retained
        // beneath it so clearing can restore it.
        bucket.entries[idx] = {
          ...existingEntry,
          owner: existingEntry.owner ?? owner,
          override: true,
          submissions: [record, ...realSubmissions],
        }
      } else {
        const entry: ScoreEntry = {
          owner,
          override: true,
          submissions: [record],
        }
        if (
          (input.assignmentType === "group" ||
            input.assignmentType === "team") &&
          input.memberUsernames &&
          input.memberUsernames.length > 0
        ) {
          entry.member_usernames = input.memberUsernames
        }
        if (input.assignmentType === "team" && input.teamSlug) {
          entry.team_slug = input.teamSlug
        }
        bucket.entries.push(entry)
      }
    }

    // Drop an emptied bucket so the file stays clean — unless the collector
    // stamped it: an empty `{type, entries: [], collected_at}` bucket is the
    // deliberate "checked at T, nothing found" freshness marker, and deleting
    // it would regress the page to the org-wide run fallback.
    if (bucket.entries.length === 0 && !("collected_at" in bucket)) {
      delete scores.assignments[assignment]
    } else {
      scores.assignments[assignment] = bucket
    }

    const message = input.clear
      ? `Clear score override: ${classroom}/${assignment} (${owner})`
      : `Set score override: ${classroom}/${assignment} (${owner})`
    const { newCommitSha } = await commitConfigRepoFiles(
      client,
      org,
      head,
      [jsonFileEntry(scoresFilePath(classroom), scores)],
      message,
    )

    return { newCommitSha }
  })
}
