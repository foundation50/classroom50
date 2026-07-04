export type Classroom = {
  path: string
  // Archive lifecycle flag. `active: false` means the classroom is ARCHIVED —
  // it blocks new assignments and new student accepts and drops out of the
  // default classes list, while preserving its roster/assignments. Reversible
  // (unarchive sets it back to true). Absent or true = active; legacy
  // classrooms (no `active` written) therefore read as active. Written via the
  // omitempty pattern; kept in lockstep with the CLI's classroom-v1 schema.
  active?: boolean
  term: string
  name: string
  short_name: string
  org: string
  // Per-classroom GitHub team granting rostered students read on private org
  // templates. Absent on classrooms created before this feature.
  team?: TeamRef
  // Per-classroom GitHub staff teams backing in-app roles. Each is a `secret`
  // team `classroom50-<short_name>-<role>` granted config-repo write;
  // ensured-on-touch. Absent on classrooms created before this feature.
  teams?: {
    instructor?: TeamRef
    ta?: TeamRef
  }
  // Optional capability-URL secret. When present, this classroom's Pages
  // resources live under `<classroom>/<secret>/...` (every consumer inserts it);
  // when absent, the plain `<classroom>/...` path. Opt-in per classroom (off by
  // default). Kept in lockstep with the CLI's classroom-v1 schema (`[a-z0-9]{4,64}`).
  secret?: string
}

// A minimal GitHub team identity (slug is authoritative for ops; id is the
// immutable handle). Mirrors classroom-v1's `teamRef` $def.
export type TeamRef = {
  id: number
  slug: string
}

// The two staff roles modeled as per-classroom GitHub teams, named
// `classroom50-<short_name>-<StaffRole>`.
export type StaffRole = "instructor" | "ta"

export const STAFF_ROLES: readonly StaffRole[] = ["instructor", "ta"]

// A classroom is archived when `active` is explicitly false. Absent or true
// reads as active, so legacy classrooms (which never wrote `active`) are active.
export const isClassroomArchived = (cl: { active?: boolean }): boolean =>
  cl.active === false

// Inclusive bounds for a group assignment's max_group_size (owner included).
// The CLI schema enforces the same range; an out-of-range value makes
// assignments.json unparseable, so form and mutation layer both clamp/guard.
export const GROUP_SIZE_MIN = 2
export const GROUP_SIZE_MAX = 100

// The two assignment modes (classroom50/assignments/v1). `individual` = one
// repo per student; `group` = a shared repo (requires max_group_size).
export type AssignmentMode = "individual" | "group"

const ASSIGNMENT_MODES: readonly AssignmentMode[] = ["individual", "group"]

// Narrow a form/string value to AssignmentMode, throwing on a value the CLI
// schema would reject.
export function assertAssignmentMode(value: string): AssignmentMode {
  if ((ASSIGNMENT_MODES as readonly string[]).includes(value)) {
    return value as AssignmentMode
  }
  throw new Error(
    `mode: must be one of ${ASSIGNMENT_MODES.join(", ")} (got "${value}").`,
  )
}

// Mirrors one entry of classroom50/assignments/v1 — the shape gh-teacher writes
// and parses strictly (unknown fields rejected).
// Schema: https://github.com/foundation50/classroom50/blob/main/schemas/assignments-v1.schema.json
export type Assignment = {
  slug: string
  name: string
  description?: string
  // Optional starter-code repo. Omitted for a template-less assignment, where
  // the accept flow creates an empty repo with only the autograder shim.
  template?: {
    owner: string
    repo: string
    branch: string
  }
  due?: string
  due_meta?: DueMeta
  mode: AssignmentMode
  // Workflow-shim name (`default` for the universal shim), not the grading logic.
  autograder: string
  max_group_size?: number
  feedback_pr?: boolean
  runtime?: {
    "runs-on"?: string | string[]
    container?: {
      image: string
      user?: string
    }
  }
  // Ordered .gitignore-style allowlist (last match wins, `!` re-includes).
  // Empty/absent = all files allowed. Enforced server-side.
  allowed_files?: string[]
  // Integer percentage (0–100) at/above which a submission counts as "passing"
  // in the gradebook's Passing rollup, badges, and passing/failing filter. A
  // display/contract field only — it does not change a student's actual score
  // (grading is points-based via the autograder). Absent = default (see
  // DEFAULT_PASS_THRESHOLD). Kept in lockstep with the CLI's assignments-v1
  // schema (`pass_threshold`, integer, omitempty) — see classroom50-cli.
  pass_threshold?: number
  tests?: AssignmentTest[]
  // CLI migrate provenance. The GUI doesn't write it but must round-trip it.
  migrated_from?: MigratedFrom
}

// classroom50/assignments/v1 `migrated_from`.
export type MigratedFrom = {
  source: string
  classroom_id: number
  assignment_id: number
  original_slug?: string
  starter_repo?: string
  invite_link?: string
  migrated_at: string
}

// Inclusive bounds for an assignment's pass_threshold (integer percentage).
export const PASS_THRESHOLD_MIN = 0
export const PASS_THRESHOLD_MAX = 100

// Default passing bar when an assignment sets no pass_threshold: a submission
// must score full marks to count as "passing". Deliberately strict — a teacher
// lowers it per assignment when partial credit should count as a pass.
export const DEFAULT_PASS_THRESHOLD = 100

// Write-side provenance for `due`. Since `due` is stored as a UTC instant
// (losing wall-clock and offset), this records what was supplied. `zone` is set
// only for auto-detected offsets.
export type DueMeta = {
  input: string
  zone?: string
  offset: string
  source: "explicit-offset" | "auto-detected" | "migrated"
}

export type AssignmentTestType = "io" | "run" | "python"
export type AssignmentTestComparison = "included" | "exact" | "regex"

// One declarative autograding test (v1 testSpec, kebab-case wire keys).
// `io` compares stdout, `run` checks the exit code, `python` runs pytest.
export type AssignmentTest = {
  name: string
  type: AssignmentTestType
  setup?: string
  run: string
  input?: string
  "input-file"?: string
  expected?: string
  "expected-file"?: string
  comparison?: AssignmentTestComparison
  timeout?: number
  "exit-code"?: number
  points: number
}

// Lifecycle for an enrolment. "invited" (invite sent, no GitHub identity bound
// yet — incl. self-reported-but-unconfirmed), "enrolled" (identity bound and
// confirmed). Legacy rows ("") are treated as enrolled when they have a
// github_id, else invited.
//
// CLI coupling: students.csv is a data contract shared with the gh-teacher CLI
// (separate repo). "reconciled"/"reconciled_at" were renamed to "enrolled"/
// "enrolled_at" with intentionally NO back-compat; the CLI must move in lockstep.
export type EnrollmentStatus = "invited" | "enrolled" | ""

// How the student was added: "github" (by username, already has github_id +
// team access) or "email" (identity resolved later via onboarding). "" on
// legacy rows. A UI/analytics hint only; reconcile matches each self-report's
// YAML back to a row (invite_token, then github_id, then email), not by method.
export type EnrollmentMethod = "github" | "email" | ""

export type Student = {
  username: string
  first_name: string
  last_name: string
  email: string
  section: string
  github_id: string
  // Email-first onboarding columns (added after the original 6). Optional so
  // legacy CSVs stay valid; the CSV layer defaults them to "".
  enrollment_status?: EnrollmentStatus
  enrollment_method?: EnrollmentMethod
  // Cached emailHash(email): a stable key reconcile uses to match a self-report
  // back to this row by email (fallback after invite_token and github_id).
  email_hash?: string
  // Per-student secure-link invite token, minted by default for every row. If
  // the student onboards via that link, it's written into the self-report YAML
  // and is reconcile's strongest match key; it never names the onboarding repo.
  invite_token?: string
  invited_at?: string
  // UTC instant reconcile bound a GitHub identity into this row
  // (enrollment_status -> "enrolled"). Empty until then.
  enrolled_at?: string
}
