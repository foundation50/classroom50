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
  // team `classroom50-<short_name>-<role>`. Teacher and head-TA (`hta`) teams
  // are granted config-repo write; the `ta` team is read-only. Ensured on
  // touch. Absent on classrooms created before this feature.
  teams?: {
    teacher?: TeamRef
    hta?: TeamRef
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

// The staff roles modeled as per-classroom GitHub teams, named
// `classroom50-<short_name>-<StaffRole>`. `teacher` is canonical; `hta` (head
// TA) is the middle tier granted config-repo write but never org-owner.
export type StaffRole = "teacher" | "hta" | "ta"

// The canonical staff roles used for creation, enumeration, and slug parsing,
// in rank order (`teacher` first, then the `hta` middle tier, then `ta`).
export const STAFF_ROLES: readonly StaffRole[] = ["teacher", "hta", "ta"]

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

// GitHub's repo collaborator permission ladder, low to high. The contract type
// for an assignment's student_permission and the gradebook's access controls;
// mirrors the shared Go contract.RepoPermissions and the schema enum. Defined
// here (a leaf types module) rather than imported from github-core so the
// schema contract stays self-contained.
export type RepoPermission = "pull" | "triage" | "push" | "maintain" | "admin"

// Ordered low-to-high, so a UI can render the ladder and code can compare rank.
export const REPO_PERMISSIONS: readonly RepoPermission[] = [
  "pull",
  "triage",
  "push",
  "maintain",
  "admin",
]

// The accept-time role a student gets on their own repo when an assignment sets
// no student_permission: least-privilege push for individual, admin for group
// (a group founder must manage collaborators). Mirrors the CLI default.
export function defaultStudentPermission(mode: AssignmentMode): RepoPermission {
  return mode === "group" ? "admin" : "push"
}

// When the autograder fires. Absent = "every-push". In lockstep with the CLI's
// assignments-v1 schema enum and contract.SubmissionModes (parity-tested).
export const SUBMISSION_MODES = ["every-push", "tag"] as const
export type SubmissionMode = (typeof SUBMISSION_MODES)[number]

// Per-assignment repo feature overrides (tri-state per key: absent = inherit,
// true = force on, false = force off). The `repo_features` block on Assignment,
// and the value the create/edit form round-trips. In lockstep with the CLI's
// assignments-v1 schema and the Go RepoFeatures struct.
export type RepoFeatures = {
  issues?: boolean
  wiki?: boolean
  projects?: boolean
  pull_requests?: boolean
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
  // Release date: the instant at/after which the assignment is listed on the
  // student assignments page for everyone. HIDE-BY-DEFAULT: an absent or future
  // value keeps it OFF the student list (link-only accept); an already-accepted
  // student always sees it. Listing-advisory only (assignments.json is public);
  // mirrors due/due_meta. A defensive reader also treats a hand-written null as
  // absent (hidden), though the schema types this as a string.
  available_from?: string
  available_from_meta?: DueMeta
  mode: AssignmentMode
  // Workflow-shim name (`default` for the universal shim), not the grading logic.
  autograder: string
  max_group_size?: number
  feedback_pr?: boolean
  // Truly bare student repos: accept creates the repo with no initial commit
  // and NO control files (no .classroom50.yaml, no autograde workflow), so the
  // assignment never autogrades and the Feedback PR is off. Mutually exclusive
  // with template/tests/feedback_pr/allowed_files/pass_threshold and IMMUTABLE
  // after creation. Omitted when false (CLI omitempty); absent reads as false.
  empty_repo?: boolean
  // Teacher-supplied CI on a TEMPLATED assignment: accept commits the
  // .classroom50.yaml marker and the template's content but NO autograde shim
  // (neither the default shim nor a Pages-fetched workflow), so the teacher's
  // own .github/ CI runs instead. UNLIKE empty_repo it permits a template and
  // the Feedback PR (a templated repo has a baseline commit); it excludes the
  // grading-adjacent fields and is mutually exclusive with empty_repo and a
  // non-default autograder. IMMUTABLE after creation. Omitted when false (CLI
  // omitempty); absent reads as false. In lockstep with the CLI's
  // assignments-v1 schema (`no_autograder`).
  no_autograder?: boolean
  // Built-in autograder on an otherwise-empty repo: a TEMPLATE-LESS assignment
  // whose repo is initialized with ONLY the marker + default autograde shim (no
  // README, no other starter content) and which DOES autograde (produces
  // submit/* releases). UNLIKE empty_repo (bare, no shim, never grades) it
  // commits the shim; it permits the grading-adjacent fields. Mutually
  // exclusive with empty_repo, a template, no_autograder, and a non-default
  // autograder; requires the default autograder. IMMUTABLE after creation.
  // Omitted when false (CLI omitempty); absent reads as false. In lockstep with
  // the CLI's assignments-v1 schema (`init_shim`).
  init_shim?: boolean
  // Copy ALL of the template's branches (not just the default) when each student
  // repo is generated: accept passes include_all_branches to GitHub's POST
  // /generate. Requires a template; mutually exclusive with empty_repo/init_shim
  // (template-less, never generated); compatible with everything else (branches
  // don't affect grading). Accept-time only and MUTABLE (not immutable — only
  // affects repos generated from now on). Omitted when false; absent reads as
  // false. In lockstep with the CLI's assignments-v1 schema (`include_all_branches`).
  include_all_branches?: boolean
  // Lock the assignment against student access. Every student surface (accept
  // page, assignments list, submission view, and `gh student accept`) refuses
  // a locked assignment for EVERY student, including one who already accepted.
  // Unlike available_from (listing-advisory), this is access control — but the
  // client gates are still best-effort UX since assignments.json is public.
  // The enforceable boundary applies only to a PRIVATE in-org template:
  // locking also removes the classroom STUDENT team's read on it (teacher/
  // head-TA/TA untouched); unlocking re-grants it. Existing student repos are
  // not deleted. Omitted when false (CLI omitempty); absent reads as false.
  locked?: boolean
  // Mirrors classroom50/assignments/v1's `runtime` block and the CLI's
  // RuntimeRef. `runs-on`/`container` select the runner; python/node/java/go/rust
  // pick the setup-X toolchain version the autograder provisions; apt installs
  // extra Ubuntu packages (mutually exclusive with `container` — the image owns
  // its packages). All optional; an absent block means the defaults
  // (ubuntu-latest + Python 3.14).
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
  // Ordered exact workspace-relative paths whose files upload as extra
  // submission-release assets, pass or fail. Empty/absent disables.
  release_assets?: string[]
  // Integer percentage (0–100) at/above which a submission counts as "passing"
  // in the gradebook rollup, badges, and passing/failing filter. Display/contract
  // only — it doesn't change a student's actual (points-based) score. Absent =
  // DEFAULT_PASS_THRESHOLD. In lockstep with the CLI's assignments-v1 schema
  // (`pass_threshold`, integer, omitempty).
  pass_threshold?: number
  // The collaborator role the enrolled student is granted on their OWN repo at
  // accept time (the old GitHub Classroom "grant students admin" checkbox,
  // generalized). Absent = the mode default (push individual / admin group).
  // Accept-time provisioning only: it governs NEW accepters, not repos already
  // accepted (adjust those with the gradebook access controls). For group mode,
  // a value below admin is clamped up to admin (a founder must manage members).
  // In lockstep with the CLI's assignments-v1 schema (`student_permission`).
  student_permission?: RepoPermission
  // When the autograder fires. Absent or "every-push" (the wire default —
  // writers omit it): the shim grades every default-branch push plus submit/*
  // tags. "tag": the shim grades ONLY submit/* tag pushes, which both submit
  // clients create after the branch push — a plain `git push` does not grade.
  // Baked into the shim at accept time; changing it later requires
  // retrofitting existing repos' shims (gradebook bulk action or
  // `gh teacher assignment submission-mode`). Mutually exclusive with
  // empty_repo (no shim exists). In lockstep with the CLI's assignments-v1
  // schema enum (`submission_mode`).
  submission_mode?: SubmissionMode
  // Teacher-named milestone tag patterns (e.g. ["phase1", "v*"]) that ALSO
  // trigger grading, alongside the always-on canonical submit/* namespace.
  // TRIGGERS, not records: the runner still mints/reuses the canonical
  // submit/* tag at the triggering commit and publishes the Release there.
  // Baked into the shim at accept time (union with submit/*); changing
  // patterns later requires the same shim retrofit as submission_mode.
  // Empty/absent = no milestone tags. Mutually exclusive with empty_repo.
  // In lockstep with the CLI's assignments-v1 schema (`submission_tags`);
  // validation in @/util/submissionTags.
  submission_tags?: string[]
  // Per-assignment repo feature overrides applied to each student repo at
  // accept time, on fresh create only. Each key is tri-state: absent = inherit
  // (a templated assignment carries the template's setting through GitHub's
  // generate; a template-less one leaves GitHub's own create default, no PATCH
  // key sent), true = force on, false =
  // force off. Not retrofitted to already-accepted repos, not re-asserted on
  // re-accept. In lockstep with the CLI's assignments-v1 schema and the Go
  // RepoFeatures struct (`repo_features`, closed object).
  repo_features?: RepoFeatures
  tests?: AssignmentTest[]
  // CLI migrate provenance. The GUI doesn't write it but must round-trip it.
  migrated_from?: MigratedFrom
}

// Trimmed assignment description, or "" when absent. assignments.json is read
// with an unchecked `as` cast, so a teacher-authored non-string `description:`
// (a YAML block/list/number) would otherwise reach `.trim()` and throw during
// render; coercing at this boundary keeps every student surface safe.
export function assignmentDescription(assignment?: Assignment): string {
  const value = assignment?.description
  return typeof value === "string" ? value.trim() : ""
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
// (teacher/ta/student, or ""), refreshed from the classroom's GitHub teams on
// sync; nothing reads it for logic. A data contract shared with the gh-teacher
// CLI and the Python collector; all moved in lockstep.
export type Student = {
  username: string
  first_name: string
  last_name: string
  email: string
  section: string
  github_id: string
  role: string
}
