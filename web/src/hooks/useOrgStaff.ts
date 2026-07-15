import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { myTeamsQuery } from "@/github-core/queries"
import { parseClassroomTeamSlug } from "@/util/teamSlug"
import type { OrgStaffVerdict } from "@/util/resolveRole"

export type UseOrgStaffResult = OrgStaffVerdict & {
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

// Org-level "staff of any classroom" signal for surfaces with NO classroom in
// scope (Published page, "My Classes" nav, ClassesPage): staff iff the viewer is
// a confirmed member of >=1 classroom's instructor/ta team in this org.
//
// Derived DIRECTLY from the viewer's own team memberships (GET /user/teams, a
// self-scoped read that returns secret teams they belong to) — NOT from the
// config repo. This is the key property: a student can't read the config-repo
// class listing (404), but they CAN list their own teams, so the signal never
// hinges on config-repo access and a non-staff viewer cleanly resolves to
// non-staff rather than an unresolvable error. Replaces the config-repo
// `.pull`-as-teacher heuristic (owner-scoped UI stays gated on can("manageOrg");
// an owner on no staff team recovers via ClaimInstructor).
//
// Fail-closed tri-state: a confirmed staff team in this org => staff; a
// successful listing with no matching team => definitive non-staff; a
// transient/in-flight read => unresolved (hold; never demote a real staffer).
export function useOrgStaff(org: string | undefined): UseOrgStaffResult {
  const client = useGitHubClient()
  const { user } = useGithubAuth()
  const username = user?.login

  const enabled = Boolean(org && username)
  const teamsQuery = useQuery({ ...myTeamsQuery(client), enabled })

  // Staff iff any of the viewer's teams IN THIS ORG parses to a classroom staff
  // slug (classroom50-<classroom>-<instructor|ta>). Cross-org teams are filtered
  // out by organization.login; the student team (no role suffix) parses to null.
  const isStaff = Boolean(
    teamsQuery.data?.some(
      (team) =>
        team.organization.login === org && parseClassroomTeamSlug(team.slug),
    ),
  )

  // Resolve only on a definitively-successful listing (or a confirmed staff
  // team). A transient/in-flight read holds unresolved so a real staffer is
  // never demoted on a blip.
  const roleResolved = enabled && (isStaff || teamsQuery.isSuccess)
  const verdict: OrgStaffVerdict = {
    isStaff,
    isNonStaff: roleResolved && !isStaff,
    roleResolved,
  }

  // A disabled hook (org-less route, no viewer) is NOT loading — it has nothing
  // to resolve; callers gate on roleResolved. Keying on fetchStatus avoids
  // pinning a permanent spinner on org-less surfaces (the footer role label).
  const isLoading = teamsQuery.fetchStatus === "fetching"

  // Surface a settled error (the teams read exhausted retries) with the role
  // still unresolved, so the gate offers retry instead of a stuck spinner.
  const isError = !roleResolved && !isLoading && teamsQuery.isError

  const refetch = () => {
    void teamsQuery.refetch()
  }

  return { ...verdict, isLoading, isError, refetch }
}
