export type Classroom = {
  path: string
  // Archive lifecycle flag. `active: false` = ARCHIVED: blocks new assignments
  // and student accepts and drops out of the default classes list, while
  // preserving roster/assignments. Reversible. Absent or true = active, so
  // legacy classrooms (no `active` written) read as active. Written omitempty;
  // in lockstep with the CLI's classroom-v1 schema.
  active?: boolean
  term: string
  name: string
  short_name: string
  org: string
  // Per-classroom GitHub team granting rostered students read on private org
  // templates. Absent on classrooms created before this feature.
  team?: TeamRef
  // Per-classroom GitHub staff teams backing in-app roles. Each is a `secret`
  // team `classroom50-<short_name>-<role>` granted config-repo write, ensured
  // on touch. Absent on classrooms created before this feature.
  teams?: {
    instructor?: TeamRef
    ta?: TeamRef
  }
  // Optional capability-URL secret. When present, this classroom's Pages
  // resources live under `<classroom>/<secret>/...` (every consumer inserts it);
  // else the plain `<classroom>/...` path. Opt-in, off by default. In lockstep
  // with the CLI's classroom-v1 schema (`[a-z0-9]{4,64}`).
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

// Archived when `active` is explicitly false (see the `active` field).
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
  // Mirrors classroom50/assignments/v1's `runtime` block and the CLI's
  // RuntimeRef. `runs-on`/`container` select the runner; python/node/java/go/rust
  // pick the setup-X toolchain version the autograder provisions; apt installs
  // extra Ubuntu packages (mutually exclusive with `container` — the image owns
  // its packages). All optional; an absent block means the defaults
  // (ubuntu-latest + Python 3.12).
  runtime?: {
    "runs-on"?: string | string[]
    container?: {
      image: string
      user?: string
    }
    python?: string
    node?: string
    java?: string
    go?: string
    rust?: string
    apt?: string[]
  }
  // Ordered .gitignore-style allowlist (last match wins, `!` re-includes).
  // Empty/absent = all files allowed. Enforced server-side.
  allowed_files?: string[]
  // Integer percentage (0–100) at/above which a submission counts as "passing"
  // in the gradebook rollup, badges, and passing/failing filter. Display/contract
  // only — it doesn't change a student's actual (points-based) score. Absent =
  // DEFAULT_PASS_THRESHOLD. In lockstep with the CLI's assignments-v1 schema
  // (`pass_threshold`, integer, omitempty).
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
// must score full marks. Deliberately strict — a teacher lowers it when partial
// credit should count as a pass.
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

// The roster's identity/metadata columns — the classroom GitHub team is the
// source of truth for enrollment, so the email-first onboarding lifecycle
// columns were pruned. `role` is best-effort recorded metadata
// (instructor/ta/student, or ""), refreshed from the classroom's GitHub teams
// on sync; nothing reads it for logic. A data contract shared with the
// gh-teacher CLI and the Python collector; all three moved in lockstep.
export type Student = {
  username: string
  first_name: string
  last_name: string
  email: string
  section: string
  github_id: string
  role: string
}
