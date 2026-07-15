import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import useGetClasses from "@/hooks/useGetClasses"
import { classroomTeamSlug } from "@/util/teamSlug"
import { REPO_READ_CONCURRENCY } from "@/github-core/queries"
import { GitHubAPIError, retryTransientGitHubError } from "@/github-core/errors"
import { mapWithConcurrency } from "@/util/concurrency"
import { resolveOrgStaff, type OrgStaffVerdict } from "@/util/resolveRole"
import type { GitHubTeamMembership } from "@/util/roles"
import { STAFF_ROLES } from "@/types/classroom"
import type { GitHubClient } from "@/github-core/client"

export type UseOrgStaffResult = OrgStaffVerdict & {
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

// Probe one staff team's self-membership: 2xx+active => member, a definitive 404
// => non-member. Anything else (incl. an SSO/blocked 403, or a transient
// 5xx/429) rethrows so the aggregate query's fail-closed retry runs and the
// verdict stays unresolved rather than demoting a real staffer.
async function probeMembership(
  client: GitHubClient,
  org: string,
  slug: string,
  username: string,
): Promise<GitHubTeamMembership> {
  const path = `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
    slug,
  )}/memberships/${encodeURIComponent(username)}`
  try {
    const membership = await client.request<{ state?: string }>(path)
    return membership.state === "active" ? "member" : "non-member"
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return "non-member"
    throw err
  }
}

// Org-level "staff of any classroom" signal for surfaces with NO classroom in
// scope (Published page, "My Classes" nav, ClassesPage): staff iff the viewer is
// a confirmed member of >=1 classroom's instructor/ta team. Replaces the
// config-repo `.pull`-as-teacher heuristic (owner-scoped UI stays on
// can("manageOrg"); an owner on no staff team recovers via ClaimInstructor).
export function useOrgStaff(org: string | undefined): UseOrgStaffResult {
  const client = useGitHubClient()
  const { user } = useGithubAuth()
  const username = user?.login
  const {
    classes,
    isSuccess: classesSuccess,
    isLoading: classesLoading,
    isError: classesError,
    refetch: refetchClasses,
  } = useGetClasses(org)

  // One self-membership probe per (classroom, staff role) — up to 2N GETs.
  const slugs = classes.flatMap((cl) =>
    STAFF_ROLES.map((role) => classroomTeamSlug(cl.name, role)),
  )

  // Aggregate the probes into ONE query whose queryFn fans out through
  // mapWithConcurrency at REPO_READ_CONCURRENCY — a large-N org otherwise bursts
  // 2N simultaneous GETs (secondary-rate-limit territory, the same risk that
  // limiter guards for batch repo reads). A confirmed membership short-circuits
  // the remaining probes. A transient probe error rethrows so the query retries
  // (fail-closed: the verdict holds unresolved rather than settling non-staff).
  const enabled = Boolean(org && username && classesSuccess)
  const probeQuery = useQuery({
    queryKey: ["org-staff-probes", org ?? "", username ?? "", slugs],
    queryFn: async (): Promise<GitHubTeamMembership[]> => {
      let foundMember = false
      return mapWithConcurrency(slugs, REPO_READ_CONCURRENCY, async (slug) => {
        if (foundMember) return "unresolved"
        const signal = await probeMembership(
          client,
          org ?? "",
          slug,
          username ?? "",
        )
        if (signal === "member") foundMember = true
        return signal
      })
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: retryTransientGitHubError,
  })

  // Resolution requires the viewer known AND a definitively-SUCCESSFUL class
  // list AND the probes settled: an in-flight or errored class list yields
  // classes=[], so only a successful listing + settled probes lets the verdict
  // resolve (an error holds unresolved and surfaces isError below — never demote
  // a real staffer on a blip).
  const signals = probeQuery.data ?? []
  const probesResolved = enabled && probeQuery.isSuccess
  const verdict = resolveOrgStaff(signals, probesResolved)

  // A disabled hook (org-less route, no viewer) is NOT loading — it has nothing
  // to resolve; callers gate on roleResolved. Including a disabled state here
  // would pin a permanent spinner on org-less surfaces (the footer role label),
  // the exact case footerRoleLabel's hasOrg guard exists to prevent.
  const isLoading = classesLoading || probeQuery.fetchStatus === "fetching"

  // Surface a settled error (class-list read failed, or probes exhausted retries)
  // with the role still unresolved, so the gate offers retry instead of a stuck
  // spinner or a false non-staff.
  const isError =
    !verdict.roleResolved && !isLoading && (classesError || probeQuery.isError)

  const refetch = () => {
    void refetchClasses()
    void probeQuery.refetch()
  }

  return { ...verdict, isLoading, isError, refetch }
}
