import { useCallback } from "react"
import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { GitHubAPIError, retryTransientGitHubError } from "./github/errors"
import { staffTeamName } from "./github/mutations"
import { classroomTeamSlugHeuristic } from "@/util/orgMembership"
import { useRoleView } from "@/context/roleView/RoleViewProvider"
import {
  resolveClassroomRole,
  applyViewAs,
  membershipFromQuery,
  type EffectiveRole,
} from "@/util/resolveRole"
import type { GitHubClient } from "./github/client"
import type { StaffRole } from "@/types/classroom"

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
// reads: the instructor, ta, and students teams (instructor > ta > student).
// Org-admin status is NOT consulted here (KTD-4) — that capability is OrgRole,
// resolved at the org boundary. Applies "view as" as a downgrade-only lens:
// `role` reflects the preview, `actualRole` is the real one.
export function useClassroomRole(
  org: string | undefined,
  classroom: string | undefined,
  username: string | undefined,
): {
  role: EffectiveRole
  actualRole: EffectiveRole
  isLoading: boolean
  isError: boolean
  refetch: () => void
} {
  const client = useGitHubClient()
  const { viewAs } = useRoleView()

  const teamSlug = (role: StaffRole) =>
    org && classroom ? staffTeamName(classroom, role) : ""
  const studentSlug =
    org && classroom ? classroomTeamSlugHeuristic(classroom) : ""

  const enabled = Boolean(org && classroom && username)
  const instructorQuery = useQuery({
    ...teamMembershipQuery(
      client,
      org ?? "",
      teamSlug("instructor"),
      username ?? "",
    ),
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
    instructor: membershipFromQuery(
      instructorQuery.isSuccess,
      instructorQuery.error,
    ),
    ta: membershipFromQuery(taQuery.isSuccess, taQuery.error),
    student: membershipFromQuery(studentQuery.isSuccess, studentQuery.error),
  })

  // Apply the "view as" preview (downgrade-only; never escalates).
  const role = applyViewAs(actualRole, viewAs)

  // Only count a query as loading when it's actually fetching — a DISABLED query
  // (e.g. team reads on an org-level route) is `pending` but idle and must not
  // pin the guard's spinner.
  const isLoading =
    instructorQuery.fetchStatus === "fetching" ||
    taQuery.fetchStatus === "fetching" ||
    studentQuery.fetchStatus === "fetching"

  // Surface a settled elevation error (retries exhausted, role still
  // `unresolved`) so the guard can offer retry instead of an endless spinner. A
  // definitive 404 already reduced to `non-member` (the role resolves), so gate
  // on the role still being `unresolved`, not on `isError` alone.
  const isError =
    actualRole === "unresolved" &&
    !isLoading &&
    (instructorQuery.isError || taQuery.isError)

  // Re-run all three team reads so an error surface can offer a retry without a
  // full page reload (mirrors useTeamRoster's refetch). Stable identity so it
  // doesn't churn the context value it's threaded through.
  const { refetch: refetchInstructor } = instructorQuery
  const { refetch: refetchTa } = taQuery
  const { refetch: refetchStudent } = studentQuery
  const refetch = useCallback(() => {
    void refetchInstructor()
    void refetchTa()
    void refetchStudent()
  }, [refetchInstructor, refetchTa, refetchStudent])

  return { role, actualRole, isLoading, isError, refetch }
}
