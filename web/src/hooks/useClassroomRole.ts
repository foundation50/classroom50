import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { orgMembershipQuery } from "./github/queries"
import { useGitHubRepo } from "./github/hooks"
import { GitHubAPIError, retryTransientGitHubError } from "./github/errors"
import { resolveTeacherVerdict } from "./useCourseTeacherAccess"
import { staffTeamName } from "./github/mutations"
import { useRoleView } from "@/context/roleView/RoleViewProvider"
import type { GitHubClient } from "./github/client"
import type { StaffRole } from "@/types/classroom"

// The viewer's effective role for the org/classroom, used by route guards and
// UI visibility. Precedence (highest first):
//   owner (org admin) > instructor > ta > student
// `unresolved` is a fail-closed sentinel: a needed signal hit a transient error,
// so callers treat it as "don't redirect; let the page load" rather than
// demoting a real staff member on a blip.
export type EffectiveRole =
  "owner" | "instructor" | "ta" | "student" | "unresolved"

// A tri-state membership signal: definitively in / definitively out / couldn't
// tell (transient). Mirrors the fail-closed posture of resolveTeacherVerdict.
export type Membership = "member" | "non-member" | "unresolved"

// Structural inputs so the verdict is a pure, unit-testable function (no React
// Query). Each signal is pre-reduced to its tri-state.
export type ClassroomRoleInput = {
  org: string | undefined
  classroom: string | undefined
  // org admin? (true => owner). undefined when not yet known.
  isOwner: boolean | undefined
  // Can the viewer read the classroom50 config repo at all? (staff gate)
  staffRoleResolved: boolean
  isStaff: boolean
  // Team memberships.
  instructor: Membership
  ta: Membership
}

// Pure role resolution. Owner short-circuits (org admin outranks everything).
// Otherwise the viewer must be staff (config-repo access) AND in a staff team
// to be instructor/ta; a definitive "not staff" makes them a student. Anything
// still in flight yields `unresolved`.
export function resolveClassroomRole(input: ClassroomRoleInput): EffectiveRole {
  const { org, classroom, isOwner, staffRoleResolved, isStaff } = input

  if (!org) return "student"

  // Owner (org admin) outranks all and isn't classroom-scoped: resolve before
  // the classroom check so an owner on an org-level route isn't misclassified.
  // While in flight (undefined) fall through.
  if (isOwner === true) return "owner"

  // Refine the CLASSROOM role (instructor/ta), which needs a classroom. A
  // non-owner on an org-level route has no finer role; hold `unresolved` while
  // ownership is still resolving so we don't flash NotFound.
  if (!classroom) return isOwner === undefined ? "unresolved" : "student"

  // Need the staff (config-repo) verdict before deciding non-owner roles.
  if (!staffRoleResolved) return "unresolved"

  // Staff team membership is definitive and outranks the (slower) owner read, so
  // resolve a confirmed instructor/ta before waiting on ownership. Only positive
  // matches are safe while isOwner is unknown — a demotion below must wait.
  if (isStaff) {
    if (input.instructor === "member") return "instructor"
    if (input.ta === "member") return "ta"
    if (input.instructor === "unresolved" || input.ta === "unresolved") {
      return "unresolved"
    }
  }

  // Ownership not yet known: don't demote. An owner needs no staff/team signal,
  // so hold `unresolved` rather than falling through to `student`.
  if (isOwner === undefined) return "unresolved"

  // A non-staff non-owner is a student, regardless of any stale team signal.
  if (!isStaff) return "student"

  // Staff (reads the config repo) but in neither staff team — treat as student;
  // owners are handled above.
  return "student"
}

// Whether a role may see/do instructor-or-TA classroom content. `unresolved` is
// permissive on purpose: the guard treats it as "let the page load".
export function isStaffRole(role: EffectiveRole): boolean {
  return (
    role === "owner" ||
    role === "instructor" ||
    role === "ta" ||
    role === "unresolved"
  )
}

// Whether a role may see/do instructor-only surfaces (org + classroom settings).
// TAs are excluded; `unresolved` is permissive (see isStaffRole).
export function isInstructorRole(role: EffectiveRole): boolean {
  return role === "owner" || role === "instructor" || role === "unresolved"
}

// The roles an instructor/owner can preview the app AS. A client-side lens for
// verifying what each role sees — never escalates.
export type ViewAsRole = "ta" | "student"

// Rank for the downgrade-only clamp. `unresolved` is intentionally absent — we
// never clamp an in-flight role (the guard is still showing a spinner).
const ROLE_RANK: Record<Exclude<EffectiveRole, "unresolved">, number> = {
  owner: 3,
  instructor: 2,
  ta: 1,
  student: 0,
}

// Apply a "view as" preview to an actual role. DOWNGRADE-ONLY: the preview can
// only lower the effective role, never raise it, so it can't be abused to gain
// access. `unresolved`/no-preview pass through unchanged.
export function applyViewAs(
  actual: EffectiveRole,
  viewAs: ViewAsRole | null,
): EffectiveRole {
  if (!viewAs || actual === "unresolved") return actual
  // Applies only when it ranks strictly below the actual role; else a no-op.
  return ROLE_RANK[viewAs] < ROLE_RANK[actual] ? viewAs : actual
}

// Translation key for the human role label: owner + instructor =>
// "nav.roleInstructor", ta => "nav.roleTa", student => "nav.roleStudent",
// unresolved => null (so callers show a skeleton mid-load). Pass through t().
export function roleLabelKey(role: EffectiveRole): string | null {
  switch (role) {
    case "owner":
    case "instructor":
      return "nav.roleInstructor"
    case "ta":
      return "nav.roleTa"
    case "student":
      return "nav.roleStudent"
    case "unresolved":
      return null
  }
}

// Reduce a team-membership query (404 => non-member, other error => unresolved)
// to the tri-state, so a blip never demotes a real staff member.
function membershipFromQuery(isSuccess: boolean, error: unknown): Membership {
  if (isSuccess) return "member"
  if (error instanceof GitHubAPIError && error.status === 404) {
    return "non-member"
  }
  // Any other error (or no answer yet) is transient — don't demote.
  return "unresolved"
}

// Team-membership query: 2xx + active => member, 404 => definitive non-member,
// anything else throws so React Query can retry and the verdict stays
// `unresolved`.
export function teamMembershipQuery(
  client: GitHubClient,
  org: string,
  teamSlug: string,
  username: string,
) {
  return {
    queryKey: ["team-membership", org, teamSlug, username] as const,
    queryFn: async () => {
      const path = `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
        teamSlug,
      )}/memberships/${encodeURIComponent(username)}`
      const membership = await client.request<{ state?: string }>(path)
      if (membership.state !== "active") {
        throw new GitHubAPIError({
          status: 404,
          url: path,
          message: "membership not active",
          body: null,
          rateLimit: {
            limit: null,
            remaining: null,
            used: null,
            reset: null,
            resource: null,
            retryAfter: null,
          },
        })
      }
      return true as const
    },
    enabled: Boolean(org && teamSlug && username),
    staleTime: 5 * 60 * 1000,
    // Definitive 404 (not a member) must not retry; transient errors self-heal.
    retry: (failureCount: number, error: unknown) => {
      if (error instanceof GitHubAPIError && error.status === 404) return false
      return failureCount < 2
    },
  }
}

// Resolve the viewer's effective role for an org/classroom from live queries:
// org membership (owner), the classroom50 repo read (staff gate), and
// instructor/ta team membership. Applies "view as" as a downgrade-only lens:
// `role` reflects the preview, `actualRole` is the real one.
export function useClassroomRole(
  org: string | undefined,
  classroom: string | undefined,
  username: string | undefined,
): { role: EffectiveRole; actualRole: EffectiveRole; isLoading: boolean } {
  const client = useGitHubClient()
  const { viewAs } = useRoleView()

  const ownerQuery = useQuery({
    ...orgMembershipQuery(client, org ?? ""),
    enabled: Boolean(org),
    // orgMembershipQuery defaults to retry:false, but a transient blip must
    // self-heal rather than pin isOwner at `undefined` (silently demoting a real
    // owner). A 404/403 is definitive.
    retry: retryTransientGitHubError,
  })

  const staffRepoQuery = useGitHubRepo(org, "classroom50", {
    retry: retryTransientGitHubError,
  })
  const staff = resolveTeacherVerdict({
    org,
    isSuccess: staffRepoQuery.isSuccess,
    permissions: staffRepoQuery.data?.permissions,
    error: staffRepoQuery.error,
  })

  const teamRole = (role: StaffRole) =>
    org && classroom ? staffTeamName(classroom, role) : ""

  const instructorQuery = useQuery({
    ...teamMembershipQuery(
      client,
      org ?? "",
      teamRole("instructor"),
      username ?? "",
    ),
    enabled: Boolean(org && classroom && username),
  })
  const taQuery = useQuery({
    ...teamMembershipQuery(client, org ?? "", teamRole("ta"), username ?? ""),
    enabled: Boolean(org && classroom && username),
  })

  // owner = active org admin. A success or a 404/403 both give a concrete
  // true/false; only an in-flight/transient read leaves it `undefined`, which
  // the resolver holds as `unresolved`.
  const ownerErrorIsDefinitive =
    ownerQuery.error instanceof GitHubAPIError &&
    (ownerQuery.error.status === 404 || ownerQuery.error.status === 403)
  const isOwner =
    ownerQuery.data?.state === "active" && ownerQuery.data.role === "admin"
      ? true
      : ownerQuery.isSuccess || ownerErrorIsDefinitive
        ? false
        : undefined

  const actualRole = resolveClassroomRole({
    org,
    classroom,
    isOwner,
    staffRoleResolved: staff.roleResolved,
    isStaff: staff.isTeacher,
    instructor: membershipFromQuery(
      instructorQuery.isSuccess,
      instructorQuery.error,
    ),
    ta: membershipFromQuery(taQuery.isSuccess, taQuery.error),
  })

  // Apply the "view as" preview (downgrade-only; never escalates).
  const role = applyViewAs(actualRole, viewAs)

  // Only count a query as loading when it's actually fetching — a DISABLED query
  // (e.g. team reads on an org-level route) is `pending` but idle and must not
  // pin the guard's spinner.
  const isLoading =
    ownerQuery.fetchStatus === "fetching" ||
    staffRepoQuery.fetchStatus === "fetching" ||
    instructorQuery.fetchStatus === "fetching" ||
    taQuery.fetchStatus === "fetching"

  return { role, actualRole, isLoading }
}
