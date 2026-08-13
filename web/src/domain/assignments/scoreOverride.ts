import type { GitHubClient } from "@/github-core/client"
import {
  getBranchRef,
  getCommit,
  getConfigRepoBranch,
} from "@/github-core/configRepoReads"
import {
  createGitCommit,
  createGitTree,
  updateRef,
} from "@/github-core/mutations"
import { CONFIG_REPO } from "@/util/configRepo"
import { decodeBase64Utf8 } from "@/util/github"
import { GitHubAPIError } from "@/github-core/errors"
import { prefixCommit } from "@/util/commit"
import { withGitConflictRetry, assertClassroomNotArchived } from "../classrooms"

// A stored submission record inside scores.json (classroom50/result/v1 payload
// minus the bucket-key `assignment`). We only type the fields the override path
// reads or writes; unknown fields are preserved verbatim on read-modify-write.
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
  [key: string]: unknown
}

type ScoreEntry = {
  owner: string
  member_usernames?: string[]
  submissions: SubmissionRecord[]
  override?: boolean
  [key: string]: unknown
}

type AssignmentBucket = {
  type: "individual" | "group"
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

// scores.json is the classroom gradebook (written by the CLI collector). The
// web is otherwise a pure reader; this is the one write path.
function scoresFilePath(classroom: string): string {
  return `${classroom}/scores.json`
}

export type SetScoreOverrideInput = {
  org: string
  classroom: string
  assignment: string
  // Repo owner login — the stable per-bucket key (individual student, or group
  // founder). Case-insensitive on match; stored as given for a new entry.
  owner: string
  // Group crediting for a new entry (individual entries omit it and are
  // credited to `owner`). Ignored when clearing.
  memberUsernames?: string[]
  assignmentType: "individual" | "group"
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
  let file: { type: "file"; encoding: "base64"; content: string }
  try {
    file = await client.request<{
      type: "file"
      encoding: "base64"
      content: string
    }>(
      `/repos/${org}/${CONFIG_REPO}/contents/${scoresFilePath(
        classroom,
      )}?ref=${encodeURIComponent(ref)}`,
    )
  } catch (err) {
    // ONLY a genuine 404 means the file is absent (never collected) — scaffold
    // so an override can seed it. Any other error (5xx / rate-limit / network)
    // is NOT proof of absence: swallowing it here would let the caller commit a
    // full-content blob that replaces the whole gradebook with this scaffold.
    // Rethrow so the write fails loudly and the caller can retry, mirroring
    // assertClassroomNotArchived's non-404 rethrow.
    if (err instanceof GitHubAPIError && err.isNotFound) {
      return { schema: SCORES_SCHEMA, assignments: {} }
    }
    throw err
  }
  // Decode/parse OUTSIDE the 404-tolerated region: a truncated or malformed
  // body must fail the save, not scaffold an empty gradebook over real scores.
  const parsed = JSON.parse(decodeBase64Utf8(file.content)) as ScoresFile
  if (!parsed.assignments) parsed.assignments = {}
  return parsed
}

// Upsert (or clear) a teacher score override for one repo owner in scores.json,
// then commit it to the config repo. The entry is written with `override: true`
// so the CLI collector preserves it verbatim (collect_scores.py apply_updates
// skips override:true entries), which is what makes a manual grade — and an
// override of an autograded score — survive re-collection. The whole thing is
// wrapped in withGitConflictRetry so a race with the nightly collect run (or
// another teacher) re-reads and retries transparently.
export async function editScoreOverride(
  client: GitHubClient,
  input: SetScoreOverrideInput,
): Promise<SetScoreOverrideResult> {
  const { org, classroom, assignment, owner } = input

  return withGitConflictRetry(async () => {
    const [, configBranch] = await Promise.all([
      assertClassroomNotArchived(client, org, classroom),
      getConfigRepoBranch(client, org),
    ])
    const ref = await getBranchRef(client, org, configBranch)
    const commit = await getCommit(client, org, ref.object.sha)

    const scores = await readScoresFile(client, org, classroom, ref.object.sha)
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
          input.assignmentType === "group" &&
          input.memberUsernames &&
          input.memberUsernames.length > 0
        ) {
          entry.member_usernames = input.memberUsernames
        }
        bucket.entries.push(entry)
      }
    }

    // Drop an emptied bucket so the file stays clean.
    if (bucket.entries.length === 0) {
      delete scores.assignments[assignment]
    } else {
      scores.assignments[assignment] = bucket
    }

    const tree = await createGitTree(client, {
      org,
      base_tree: commit.tree.sha,
      tree: [
        {
          path: scoresFilePath(classroom),
          mode: "100644",
          type: "blob",
          content: JSON.stringify(scores, null, 2) + "\n",
        },
      ],
    })
    const message = input.clear
      ? `Clear score override: ${classroom}/${assignment} (${owner})`
      : `Set score override: ${classroom}/${assignment} (${owner})`
    const newCommit = await createGitCommit(client, {
      org,
      message: prefixCommit(message),
      tree_sha: tree.sha,
      parents: [ref.object.sha],
    })
    await updateRef(client, org, newCommit.sha, configBranch)

    return { newCommitSha: newCommit.sha }
  })
}
