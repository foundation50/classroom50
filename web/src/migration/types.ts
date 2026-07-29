// FEATURE: github-classroom-migration — removable once GitHub Classroom shuts
// down (see foundation50/classroom50#312). Shared types for the web migration
// flow: the GitHub Classroom REST source shapes and the internal preflight/
// execute plan shapes. Deleting web/src/migration/ + web/src/pages/migration/ +
// the route + hook + migration.* i18n keys removes the feature.

// --- GitHub Classroom REST source shapes (mirrors the CLI's migrate_source.go) ---

// One row of `GET /classrooms`. The listing lacks `organization`, so resolving a
// classroom's org needs a follow-up `GET /classrooms/{id}`.
export type ClassroomListItem = {
  id: number
  name: string
  archived: boolean
  url: string
}

// `GET /classrooms/{id}` — the listing plus the organization block.
export type ClassroomDetail = {
  id: number
  name: string
  archived: boolean
  url: string
  organization: {
    id: number
    login: string
    node_id?: string
    html_url?: string
    name?: string | null
    avatar_url?: string
  }
}

// One row of `GET /classrooms/{id}/assignments`.
export type ClassroomAssignmentListItem = {
  id: number
  title: string
  slug: string
  type: string
}

// The source starter repo fields migration consumes.
export type ClassroomStarterCodeRepo = {
  id: number
  name: string
  full_name: string
  private: boolean
  default_branch: string
}

// `GET /assignments/{id}`. `deadline` is nullable in the source; null vs "" is
// meaningful, so it stays `string | null`.
export type ClassroomAssignmentDetail = {
  id: number
  public_repo: boolean
  title: string
  type: string
  invite_link: string
  slug: string
  deadline: string | null
  max_teams: number | null
  starter_code_repository: ClassroomStarterCodeRepo | null
}

// A source classroom paired with its resolved org login, for the picker.
export type ClassroomWithOrg = ClassroomListItem & { orgLogin: string }

// --- Preflight / execute plan shapes ---

// What template-copy will do (preflight) or did (execute) for one assignment.
export type MigrationItemAction = "import" | "reuse" | "skip"

// A structured, translatable reason for a reuse/skip outcome. `key` is an
// i18n key under `migration.reason.*`; `params` fills its interpolations.
export type MigrationReason = {
  key: string
  params?: Record<string, string>
}

// The per-assignment preflight outcome shown on the confirm screen and reused
// to drive execute. `targetName` is the repo name in the target org; `branch`/
// `targetPrivate` are set for a reuse of an existing target template.
export type MigrationItem = {
  assignment: ClassroomAssignmentDetail
  action: MigrationItemAction
  reason?: MigrationReason
  targetName: string
  branch?: string
  targetPrivate?: boolean
}

// A blocker that disables the whole import until resolved.
export type MigrationBlockerKind = "needs_org_setup" | "dir_exists"
export type MigrationBlocker = {
  kind: MigrationBlockerKind
  params?: Record<string, string>
}

// The full read-only plan the confirm screen renders and execute consumes.
export type MigrationPreflight = {
  classroom: ClassroomDetail
  targetOrg: string
  shortName: string
  term: string
  templateSuffix: string
  items: MigrationItem[]
  counts: { import: number; reuse: number; skip: number }
  blockers: MigrationBlocker[]
}

// Per-item execute progress, streamed to the UI.
export type MigrationItemStatus = {
  slug: string
  targetName: string
  status: "pending" | "running" | "generated" | "reused" | "skipped"
  reason?: MigrationReason
}

// The truthful post-run result.
export type MigrationResult = {
  shortName: string
  commitSha: string
  generated: number
  reused: number
  skipped: Array<{ slug: string; reason?: MigrationReason }>
}
