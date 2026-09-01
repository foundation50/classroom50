import type { GitHubClient } from "@/github-core/client"
import type { GitHubTeam, MyTeam } from "@/github-core/types"
import { GitHubAPIError, tolerateGitHubError } from "@/github-core/errors"
import { createTeam } from "@/github-core/teamWrites"
import {
  addRepositoryToTeam,
  addUserToTeam,
  removeUserFromTeam,
} from "@/github-core/mutations"
import { listMyTeams, listOrgTeams } from "@/github-core/queries"
import {
  GROUP_TEAM_PATTERN,
  groupTeamAssignmentPrefix,
  groupTeamName,
  isGroupTeamSlug,
  parseGroupTeamCounter,
} from "@/util/teamSlug"
import {
  marshalGroupDescription,
  parseGroupDescription,
  verifyGroupDescription,
} from "@/util/groupTeam"
import { localizedError } from "@/types/localizedMessage"
import type { TeamFormation } from "@/types/classroom"
import { logger } from "@/lib/logger"

const log = logger.scope("domain:groupTeams")

// One group team as the app consumes it: the canonical slug (== name), the
// immutable id (delete guard), the counter n (maps to the repo name), and the
// students' display name — taken from the description record only when the
// record verifies back to the slug (a maintainer-edited record must not
// re-attribute or re-label another assignment's team).
export type GroupTeamRef = {
  slug: string
  id: number
  n: number
  name?: string
}

// Counter allocation seed: the lowest n >= 1 not in `taken`. Only a seed — a
// secret team is invisible to non-members, so a listing can't prove a counter
// free; the create-time 422 retry (createGroupTeam) is the real allocator.
export function lowestFreeCounter(taken: ReadonlySet<number>): number {
  let n = 1
  while (taken.has(n)) n++
  return n
}

// The taken counters visible in a team listing, for one assignment's prefix.
export function takenCounters(
  teams: { slug: string }[],
  assignmentPrefix: string,
): Set<number> {
  const taken = new Set<number>()
  for (const team of teams) {
    const n = parseGroupTeamCounter(team.slug, assignmentPrefix)
    if (n !== null) taken.add(n)
  }
  return taken
}

// Resolve a listed team to a GroupTeamRef for one assignment, or null when it
// isn't that assignment's group team. The display name is trusted only when
// the description record verifies back to the slug's hash.
async function toGroupTeamRef(
  team: Pick<GitHubTeam, "slug" | "id" | "description">,
  assignmentPrefix: string,
): Promise<GroupTeamRef | null> {
  const n = parseGroupTeamCounter(team.slug, assignmentPrefix)
  if (n === null) return null
  const record = parseGroupDescription(team.description)
  const verified =
    record !== null && (await verifyGroupDescription(team.slug, record))
  return {
    slug: team.slug,
    id: team.id,
    n,
    ...(verified && record.name ? { name: record.name } : {}),
  }
}

// Every group team of one assignment, from the org team listing (teacher
// view: an org owner sees all secret teams). Sorted by counter for a stable
// UI order. A non-owner's listing degrades to [] inside listOrgTeams.
export async function listAssignmentGroupTeams(
  client: GitHubClient,
  org: string,
  classroom: string,
  assignment: string,
): Promise<GroupTeamRef[]> {
  const prefix = await groupTeamAssignmentPrefix(classroom, assignment)
  const teams = await listOrgTeams(client, org)
  const refs: GroupTeamRef[] = []
  for (const team of teams) {
    if (!team.slug?.startsWith(prefix) || !isGroupTeamSlug(team.slug)) continue
    const ref = await toGroupTeamRef(team, prefix)
    if (ref) refs.push(ref)
  }
  return refs.sort((a, b) => a.n - b.n)
}

// The viewer's OWN group team for one assignment, from the self-scoped
// /user/teams listing (a student can see the secret teams they belong to and
// nothing else). Null = not on any of this assignment's teams. The hash scopes
// classroom+assignment but not the org, so a cross-org listing is filtered to
// this org first.
export async function findMyGroupTeam(
  client: GitHubClient,
  org: string,
  classroom: string,
  assignment: string,
): Promise<GroupTeamRef | null> {
  const prefix = await groupTeamAssignmentPrefix(classroom, assignment)
  const teams = await listMyTeams(client)
  const mine = teams.find(
    (team: MyTeam) =>
      team.organization?.login?.toLowerCase() === org.toLowerCase() &&
      team.slug?.startsWith(prefix) &&
      isGroupTeamSlug(team.slug),
  )
  if (!mine) return null
  return toGroupTeamRef(mine, prefix)
}

// Bounded 422-retry budget for counter allocation. 50 concurrent creators of
// the same assignment's teams is far past any real class's burst.
const CREATE_ATTEMPTS = 50

// Create one group team: a SECRET team named classroom50-group-<hash>-<n>
// carrying the classroom50/group/v1 record, notifications disabled. The
// counter is seeded from the caller-visible listing (lowest free n) and
// settled by the 422-on-create retry — never a visibility probe (a secret
// team is invisible to non-members, so a listing can't prove a counter free).
//
// GitHub auto-adds the creator as a maintainer. Student formation passes
// founderLogin === creatorLogin, so the founding student stays maintainer (and
// can add teammates). Teacher formation passes no founderLogin: the teacher is
// dropped after create so the team holds only real group members (best-effort;
// an org owner keeps full team control either way).
//
// Visibility follows the assignment's formation, not the caller: a
// student-formed team is created `closed` (visible to every org member) so
// classmates can browse existing groups and use GitHub's native
// request-to-join — which only exists on visible teams. A teacher-formed team
// stays `secret`: nobody browses it, and secrecy hides memberships from other
// classes sharing the org.
export async function createGroupTeam(
  client: GitHubClient,
  org: string,
  input: {
    classroom: string
    assignment: string
    displayName?: string
    creatorLogin: string
    founderLogin?: string
    formation: TeamFormation
  },
): Promise<GroupTeamRef> {
  const {
    classroom,
    assignment,
    displayName,
    creatorLogin,
    founderLogin,
    formation,
  } = input
  const prefix = await groupTeamAssignmentPrefix(classroom, assignment)
  const visible = await listOrgTeams(client, org)
  const taken = takenCounters(visible, prefix)
  const description = marshalGroupDescription({
    classroom,
    assignment,
    name: displayName,
  })

  let n = lowestFreeCounter(taken)
  let created: GitHubTeam | null = null
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    const name = await groupTeamName(classroom, assignment, n)
    try {
      created = await createTeam(client, {
        org,
        name,
        description,
        privacy: formation === "student" ? "closed" : "secret",
        notification_setting: "notifications_disabled",
      })
      break
    } catch (err) {
      // 422 = the counter is taken by a team this caller can't see; move to
      // the next free one. Anything else (403 org policy, 5xx) propagates.
      if (err instanceof GitHubAPIError && err.status === 422) {
        taken.add(n)
        n = lowestFreeCounter(taken)
        continue
      }
      throw err
    }
  }
  if (!created) {
    throw localizedError({
      key: "groupTeams.errors.counterExhausted",
      params: { attempts: CREATE_ATTEMPTS },
    })
  }

  if (founderLogin && founderLogin !== creatorLogin) {
    await addUserToTeam(client, {
      org,
      teamSlug: created.slug,
      username: founderLogin,
      role: "maintainer",
    })
  }
  if (!founderLogin || founderLogin !== creatorLogin) {
    // Best-effort: a lingering creator only inflates the member list; an org
    // owner can drop themselves from the team in GitHub if this fails.
    try {
      await removeUserFromTeam(client, {
        org,
        teamSlug: created.slug,
        username: creatorLogin,
      })
    } catch (err) {
      log.warn("group team: creator drop failed (non-fatal)", {
        org,
        slug: created.slug,
        err,
      })
    }
  }

  return { slug: created.slug, id: created.id, n }
}

// Pure add-member gate: max_group_size (owner included) and the roster. Throws
// localized errors so the view renders the remedy in the student's language.
// `rosterLogins` undefined = no roster available to check (the caller decides
// whether that's acceptable); an empty set still gates.
export function assertGroupMemberAddable(input: {
  username: string
  currentMemberCount: number
  maxGroupSize?: number
  rosterLogins?: ReadonlySet<string>
}): void {
  const { username, currentMemberCount, maxGroupSize, rosterLogins } = input
  if (maxGroupSize !== undefined && currentMemberCount >= maxGroupSize) {
    throw localizedError({
      key: "groupTeams.errors.groupFull",
      params: { max: maxGroupSize },
    })
  }
  if (rosterLogins && !rosterLogins.has(username.trim().toLowerCase())) {
    throw localizedError({
      key: "groupTeams.errors.notOnRoster",
      params: { username },
    })
  }
}

// Add a member to a group team, enforcing the size + roster gate first. The
// gate runs here (not only in the view) so every write path shares it.
export async function addGroupTeamMember(
  client: GitHubClient,
  org: string,
  input: {
    teamSlug: string
    username: string
    role?: "member" | "maintainer"
    currentMemberCount: number
    maxGroupSize?: number
    rosterLogins?: ReadonlySet<string>
  },
): Promise<void> {
  assertGroupMemberAddable(input)
  await addUserToTeam(client, {
    org,
    teamSlug: input.teamSlug,
    username: input.username,
    role: input.role,
  })
}

// Remove a member from a group team. Idempotent (404 = already gone).
export async function removeGroupTeamMember(
  client: GitHubClient,
  org: string,
  input: { teamSlug: string; username: string },
): Promise<void> {
  await removeUserFromTeam(client, {
    org,
    teamSlug: input.teamSlug,
    username: input.username,
  })
}

// A member leaves their own group team. Same DELETE as a removal, but the
// failure story differs: the REST docs only promise removal to team
// maintainers and org owners (self-removal works like GitHub's own Leave
// button in practice), so a 403 — an IdP-synced team, or a policy change —
// maps to a localized error pointing at the team page instead of a dead end.
// Fail-closed on role: the group's MAINTAINER may not leave (the group would
// be left with nobody who can manage it) — enforced here, not only in the
// view, via the membership read's role.
export async function leaveGroupTeam(
  client: GitHubClient,
  org: string,
  input: { teamSlug: string; username: string },
): Promise<void> {
  const membership = await tolerateGitHubError(
    () =>
      client.request<{ role?: string }>(
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(
          input.teamSlug,
        )}/memberships/${encodeURIComponent(input.username)}`,
      ),
    null,
  )
  if (membership?.role === "maintainer") {
    throw localizedError({
      key: "groupTeams.errors.maintainerCannotLeave",
      params: { slug: input.teamSlug },
    })
  }
  try {
    await removeUserFromTeam(client, {
      org,
      teamSlug: input.teamSlug,
      username: input.username,
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isForbidden) {
      throw localizedError({
        key: "groupTeams.errors.leaveForbidden",
        params: { slug: input.teamSlug },
      })
    }
    throw err
  }
}

// The team's page on GitHub — where the native request-to-join button lives
// for a visible (closed) team, and where maintainers review pending requests.
// The REST API exposes none of that flow, so both sides deep-link here.
export function groupTeamUrl(org: string, teamSlug: string): string {
  return `https://github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}`
}

// Attach the group's repo to its team with push — the authoritative repo<->team
// link (the repo NAME is display/search convention only). Idempotent PUT.
export async function attachRepoToGroupTeam(
  client: GitHubClient,
  org: string,
  teamSlug: string,
  repo: string,
): Promise<void> {
  await addRepositoryToTeam(client, {
    org,
    teamSlug,
    owner: org,
    repo,
    permission: "push",
  })
}

// Update a group team's DISPLAY name: re-derive the classroom50/group/v1
// description record with the new name and PATCH only the description — the
// team NAME (== slug) is the naming contract and never changes, so repos,
// grading, and cleanup are rename-proof by construction. An empty name clears
// the display name (the UI falls back to "Group <n>").
export async function updateGroupTeamDisplayName(
  client: GitHubClient,
  org: string,
  input: {
    slug: string
    classroom: string
    assignment: string
    name: string
  },
): Promise<void> {
  const { slug, classroom, assignment, name } = input
  if (!isGroupTeamSlug(slug)) {
    throw localizedError({
      key: "groupTeams.errors.notAGroupTeam",
      params: { slug },
    })
  }
  await client.request(
    `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`,
    {
      method: "PATCH",
      body: {
        description: marshalGroupDescription({ classroom, assignment, name }),
      },
    },
  )
}

// Delete a group team, fail-closed like deleteClassroomTeam plus the group
// record gate: the slug must match the FULL group-team shape, the live team
// must carry a classroom50/group/v1 record that verifies back to the slug AND
// names this classroom+assignment, and the live id must equal the recorded id
// (a reused slug is never clobbered blind). 404 = already gone.
export async function deleteGroupTeam(
  client: GitHubClient,
  org: string,
  input: { slug: string; id: number; classroom: string; assignment: string },
): Promise<void> {
  const { slug, id, classroom, assignment } = input
  if (!GROUP_TEAM_PATTERN.test(slug) || !Number.isInteger(id) || id <= 0) {
    throw localizedError({
      key: "groupTeams.errors.notAGroupTeam",
      params: { slug },
    })
  }

  let live: GitHubTeam
  try {
    live = await client.request<GitHubTeam>(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`,
    )
  } catch (err) {
    if (err instanceof GitHubAPIError && err.isNotFound) return
    throw err
  }

  if (live.id !== id) {
    throw localizedError({
      key: "groupTeams.errors.idMismatch",
      params: { slug },
    })
  }

  const record = parseGroupDescription(live.description)
  const verified =
    record !== null &&
    (await verifyGroupDescription(slug, record)) &&
    record.classroom.toLowerCase() === classroom.toLowerCase() &&
    record.assignment.toLowerCase() === assignment.toLowerCase()
  if (!verified) {
    throw localizedError({
      key: "groupTeams.errors.recordMismatch",
      params: { slug },
    })
  }

  await tolerateGitHubError(
    () =>
      client.request(
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`,
        { method: "DELETE" },
      ),
    undefined,
  )
}
