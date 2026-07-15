import { useQuery } from "@tanstack/react-query"
import { useGitHubClient } from "@/context/github/GitHubProvider"
import { useGithubAuth } from "@/auth/useGithubAuth"
import { useGitHubOrgRole } from "@/context/githubOrgRole/GitHubOrgRoleProvider"
import { myTeamsQuery } from "@/github-core/queries"
import { parseClassroomTeamSlug } from "@/util/teamSlug"
import { can, type OrgStaffVerdict } from "@/authz"

export type UseOrgStaffResult = OrgStaffVerdict & {
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

// Org-level "staff of any classroom" signal for surfaces with NO classroom in
// scope (Published page, "My Classes" nav, ClassesPage): staff iff the viewer is
// an org owner OR a confirmed member of >=1 classroom's instructor/ta team in
// this org.
//
// The team signal is derived DIRECTLY from the viewer's own team memberships
// (GET /user/teams, a self-scoped read that returns secret teams they belong
// to) — NOT from the config repo. This is the key property: a student can't read
// the config-repo class listing (404), but they CAN list their own teams, so the
// signal never hinges on config-repo access and a non-staff viewer cleanly
// resolves to non-staff rather than an unresolvable error. Team membership is the
// source of truth for NON-owners (a read-only config-repo collaborator is not
// staff).
//
// An org owner is staff here regardless of team membership: a freshly-configured
// org has no classroom teams yet, and the owner still needs the org-staff chrome
// (My Classrooms, the create-classroom CTA, the owner nav shortcuts) to bootstrap
// their first classroom. Creating it seeds the owner onto its instructor team, so
// the team signal takes over naturally afterward.
//
// Fail-closed tri-state: a confirmed owner or staff team => staff; a successful
// listing (non-owner) with no matching team => definitive non-staff; a
// transient/in-flight read => unresolved (hold; never demote a real staffer, and
// never flash staff chrome before the org role resolves).
export function useOrgStaff(org: string | undefined): UseOrgStaffResult {
  const client = useGitHubClient()
  const { user } = useGithubAuth()
  const { githubOrgRole } = useGitHubOrgRole()
  const username = user?.login

  const enabled = Boolean(org && username)
  const teamsQuery = useQuery({ ...myTeamsQuery(client), enabled })

  // An org owner is staff for org-level chrome regardless of team membership.
  // `unresolved` (in-flight org read) is denied by can(), so a fresh load falls
  // back to the team-based hold below rather than flashing staff.
  const isOwner = can("manageOrg", { githubOrgRole })

  // Staff iff owner, or any of the viewer's teams IN THIS ORG parses to a
  // classroom staff slug (classroom50-<classroom>-<instructor|ta>). Cross-org
  // teams are filtered out by organization.login; the student team (no role
  // suffix) parses to null.
  const isStaff =
    isOwner ||
    Boolean(
      teamsQuery.data?.some(
        (team) =>
          team.organization.login === org && parseClassroomTeamSlug(team.slug),
      ),
    )

  // Resolve on a confirmed owner or staff team, or a definitively-successful
  // listing. An owner resolves immediately (keyed on `org`, not the teams
  // `enabled`/success) so a fresh owner isn't pinned on a spinner waiting for a
  // teams read they don't need. A non-owner's transient/in-flight read holds
  // unresolved so a real staffer is never demoted on a blip.
  const roleResolved = Boolean(org) && (isStaff || teamsQuery.isSuccess)
  const verdict: OrgStaffVerdict = {
    isStaff,
    isNonStaff: roleResolved && !isStaff,
    roleResolved,
  }

  // A disabled hook (org-less route, no viewer) is NOT loading — it has nothing
  // to resolve; callers gate on roleResolved. Keying on fetchStatus avoids
  // pinning a permanent spinner on org-less surfaces (the footer role label).
  // Once resolved (e.g. an owner, who needs no teams read), we're not loading
  // even if an irrelevant teams read is still in flight.
  const isLoading = !roleResolved && teamsQuery.fetchStatus === "fetching"

  // Surface a settled error (the teams read exhausted retries) with the role
  // still unresolved, so the gate offers retry instead of a stuck spinner.
  const isError = !roleResolved && !isLoading && teamsQuery.isError

  const refetch = () => {
    void teamsQuery.refetch()
  }

  return { ...verdict, isLoading, isError, refetch }
}
