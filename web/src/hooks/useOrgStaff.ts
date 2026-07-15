import { useCallback } from "react"
import { useQueries } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import useGetClasses from "@/hooks/useGetClasses"
import { classroomTeamSlug } from "@/util/teamSlug"
import { teamMembershipQuery } from "@/hooks/useClassroomRole"
import {
  membershipFromQuery,
  resolveOrgStaff,
  type OrgStaffVerdict,
} from "@/util/resolveRole"
import { STAFF_ROLES } from "@/types/classroom"

export type UseOrgStaffResult = OrgStaffVerdict & {
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

// Org-level "staff of any classroom" signal for surfaces with NO classroom in
// scope (Published page, "My Classes" nav, ClassesPage). Team membership is the
// source of truth: the viewer is org-staff iff they are a confirmed member of at
// least one classroom's instructor/ta team. Replaces the config-repo
// `.pull`-as-teacher heuristic — a read-only config-repo collaborator or an org
// owner on no staff team is NOT org-staff here (owner-scoped UI stays gated on
// can("manageOrg"); such an owner recovers via ClaimInstructor).
//
// Request budget: one self-membership probe per classroom x staff role
// (N classrooms x STAFF_ROLES = 2N GETs), each the fail-closed `teamMembershipQuery`
// (GET /orgs/{org}/teams/{slug}/memberships/{me}; shared cache keys with
// useClassroomRole so a classroom the viewer later opens is warm). Only
// enumerable classrooms count (useGetClasses reads the config repo), and a
// confirmed membership short-circuits the verdict without waiting on siblings.
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

  // One probe per (classroom, staff role). Only meaningful once the class list
  // has loaded — an in-flight or errored list yields classes=[] here.
  const probes = classes.flatMap((cl) =>
    STAFF_ROLES.map((role) => ({
      classroom: cl.name,
      role,
      slug: classroomTeamSlug(cl.name, role),
    })),
  )

  const enabled = Boolean(org && username)
  const results = useQueries({
    queries: probes.map((p) => ({
      ...teamMembershipQuery(client, org ?? "", p.slug, username ?? ""),
      enabled,
    })),
  })

  // resolveOrgStaff only needs "is any probe confirmed member / are all
  // definitive", so a flat list across all (classroom, role) probes suffices.
  const signals = results.map((r) => membershipFromQuery(r.isSuccess, r.error))

  // Resolution requires the viewer known AND a definitively-SUCCESSFUL class
  // list: an in-flight list returns classes=[] (indistinguishable from "no
  // classrooms") and an errored list also returns [] — treating either as
  // resolved would flash/pin a premature definitive non-staff. So only a
  // successful listing lets the verdict resolve; an errored list holds
  // `unresolved` and surfaces isError below (fail-closed — never demote a real
  // staffer because the config-repo listing blipped).
  const verdict = resolveOrgStaff(signals, enabled && classesSuccess)

  const isLoading =
    !enabled ||
    classesLoading ||
    results.some((r) => r.fetchStatus === "fetching")

  // Surface a settled error (the class-list read failed, or the probes exhausted
  // retries) with the role still unresolved, so the gate offers retry instead of
  // a stuck spinner or a false non-staff.
  const isError =
    !verdict.roleResolved &&
    !isLoading &&
    (classesError || results.some((r) => r.isError))

  const refetch = useCallback(() => {
    void refetchClasses()
    for (const r of results) void r.refetch()
  }, [refetchClasses, results])

  return { ...verdict, isLoading, isError, refetch }
}
