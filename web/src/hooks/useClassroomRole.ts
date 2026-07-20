import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { GitHubAPIError, retryTransientGitHubError } from "@/github-core/errors"
import { classroomTeamSlug, type ClassroomTeamRole } from "@/util/teamSlug"
import { useRoleView } from "@/context/roleView/RoleViewProvider"
import {
  resolveClassroomRole,
  applyViewAs,
  membershipFromQuery,
  type ResolvedRole,
  type GitHubTeamMembership,
} from "@/authz"
import type { GitHubClient } from "@/github-core/client"

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
    // Fail-closed retry: a definitive 401/403/404 (revoked, blocked/SSO-gated,
    // not a member) must NOT retry — matching every sibling role read — while a
    // transient 5xx/429/network blip self-heals (bounded). A 403 that retried as
    // if transient would keep the guard's spinner up (see useClassroomRole's
    // `settled` terminal state).
    retry: retryTransientGitHubError,
  }
}

// Resolve the viewer's effective CLASSROOM role from live team-membership
// reads: the teacher, hta, ta, and students teams (teacher > hta > ta >
// student).
// The teacher signal probes BOTH the canonical `-teacher` team and the legacy
// `-instructor` team (during the rename migration a classroom may still back
// staff with either), and treats membership in either as teacher.
// Org-admin status is NOT consulted here (KTD-4) — that is GitHubOrgRole,
// resolved at the org boundary. Applies "view as" as a downgrade-only lens:
// `role` reflects the preview, `actualRole` is the real one.
export function useClassroomRole(
  org: string | undefined,
  classroom: string | undefined,
  username: string | undefined,
): {
  role: ResolvedRole
  actualRole: ResolvedRole
  isLoading: boolean
  isError: boolean
  refetch: () => void
} {
  const client = useGitHubClient()
  const { viewAs } = useRoleView()

  const teamSlug = (role: ClassroomTeamRole) =>
    org && classroom ? classroomTeamSlug(classroom, role) : ""
  const studentSlug = org && classroom ? classroomTeamSlug(classroom) : ""

  const enabled = Boolean(org && classroom && username)
  const teacherQuery = useQuery({
    ...teamMembershipQuery(
      client,
      org ?? "",
      teamSlug("teacher"),
      username ?? "",
    ),
    enabled,
  })
  // Legacy fallback: a not-yet-migrated classroom backs teachers with the
  // `-instructor` team. Membership in either team resolves to teacher.
  const instructorQuery = useQuery({
    ...teamMembershipQuery(
      client,
      org ?? "",
      teamSlug("instructor"),
      username ?? "",
    ),
    enabled,
  })
  const htaQuery = useQuery({
    ...teamMembershipQuery(client, org ?? "", teamSlug("hta"), username ?? ""),
    enabled,
  })
  const taQuery = useQuery({
    ...teamMembershipQuery(client, org ?? "", teamSlug("ta"), username ?? ""),
    enabled,
  })
  const studentQuery = useQuery({
    ...teamMembershipQuery(client, org ?? "", studentSlug, username ?? ""),
    enabled,
  })

  const actualRole = resolveClassroomRole({
    org,
    classroom,
    teacher: combineTeacherMembership(
      membershipFromQuery(teacherQuery.isSuccess, teacherQuery.error),
      membershipFromQuery(instructorQuery.isSuccess, instructorQuery.error),
    ),
    ta: membershipFromQuery(taQuery.isSuccess, taQuery.error),
    hta: membershipFromQuery(htaQuery.isSuccess, htaQuery.error),
    student: membershipFromQuery(studentQuery.isSuccess, studentQuery.error),
  })

  // Apply the "view as" preview (downgrade-only; never escalates).
  const role = applyViewAs(actualRole, viewAs)

  // Only count a query as loading when it's actually fetching — a DISABLED query
  // (e.g. team reads on an org-level route) is `pending` but idle and must not
  // pin the guard's spinner.
  const isLoading =
    teacherQuery.fetchStatus === "fetching" ||
    instructorQuery.fetchStatus === "fetching" ||
    htaQuery.fetchStatus === "fetching" ||
    taQuery.fetchStatus === "fetching" ||
    studentQuery.fetchStatus === "fetching"

  // Surface a settled elevation error (retries exhausted, role still
  // `unresolved`) so the guard can offer retry instead of an endless spinner. A
  // definitive 404 already reduced to `non-member` (the role resolves), so gate
  // on the role still being `unresolved`, not on `isError` alone.
  const isError =
    actualRole === "unresolved" &&
    !isLoading &&
    (teacherQuery.isError ||
      instructorQuery.isError ||
      htaQuery.isError ||
      taQuery.isError)

  // Re-run all team reads so an error surface can offer a retry without a
  // full page reload (mirrors useTeamRoster's refetch). Stable identity so it
  // doesn't churn the context value it's threaded through.
  const { refetch: refetchTeacher } = teacherQuery
  const { refetch: refetchInstructor } = instructorQuery
  const { refetch: refetchHta } = htaQuery
  const { refetch: refetchTa } = taQuery
  const { refetch: refetchStudent } = studentQuery
  const refetch = useCallback(() => {
    void refetchTeacher()
    void refetchInstructor()
    void refetchHta()
    void refetchTa()
    void refetchStudent()
  }, [refetchTeacher, refetchInstructor, refetchHta, refetchTa, refetchStudent])

  return { role, actualRole, isLoading, isError, refetch }
}

// Combine the canonical teacher-team and legacy instructor-team membership
// signals into one teacher tri-state: membership in EITHER is "member"; both
// definitive non-members is "non-member"; otherwise (any in-flight/transient)
// hold "unresolved" so a blip never demotes a real teacher.
export function combineTeacherMembership(
  teacher: GitHubTeamMembership,
  instructor: GitHubTeamMembership,
): GitHubTeamMembership {
  if (teacher === "member" || instructor === "member") return "member"
  if (teacher === "non-member" && instructor === "non-member") {
    return "non-member"
  }
  return "unresolved"
}
