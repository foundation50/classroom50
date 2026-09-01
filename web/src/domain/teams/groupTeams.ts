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

// GitHub's two team privacy levels as group teams use them: `closed` is
// browsable by every org member (and carries the native request-to-join flow),
// `secret` is visible only to its members and org owners.
export type GroupTeamPrivacy = "secret" | "closed"

// One group team as the app consumes it: the canonical slug (== name), the
// immutable id (delete guard), the counter n (maps to the repo name), the
// students' display name — taken from the description record only when the
// record verifies back to the slug (a maintainer-edited record must not
// re-attribute or re-label another assignment's team) — and the team's
// privacy, carried through from the listing payload when present.
export type GroupTeamRef = {
  slug: string
  id: number
  n: number
  name?: string
  privacy?: GroupTeamPrivacy
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
  team: Pick<GitHubTeam, "slug" | "id" | "description"> &
    Partial<Pick<GitHubTeam, "privacy">>,
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
    ...(team.privacy ? { privacy: team.privacy } : {}),
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

// Recreate a group team whose GitHub team was deleted, at a KNOWN counter n —
// never the lowest-free allocation: the surviving repo's name pins the
// counter, and creating any other n would orphan the repo again. Privacy is
// the caller's input (derived from the assignment's formation like
// createGroupTeam: student -> "closed", teacher -> "secret" — the formation
// isn't known here). Created notifications-disabled so recovery setup can't
// spam anyone. A 422 means the name is taken — the team exists again (another
// teacher raced the recovery) — so it maps to a refresh-and-recheck error
// instead of a dead end.
export async function recreateGroupTeam(
  client: GitHubClient,
  org: string,
  input: {
    classroom: string
    assignment: string
    n: number
    displayName?: string
    privacy: GroupTeamPrivacy
  },
): Promise<GroupTeamRef> {
  const { classroom, assignment, n, displayName, privacy } = input
  const name = await groupTeamName(classroom, assignment, n)
  const description = marshalGroupDescription({
    classroom,
    assignment,
    name: displayName,
  })
  let created: GitHubTeam
  try {
    created = await createTeam(client, {
      org,
      name,
      description,
      privacy,
      notification_setting: "notifications_disabled",
    })
  } catch (err) {
    if (err instanceof GitHubAPIError && err.status === 422) {
      throw localizedError({
        key: "groupTeams.errors.recreateNameTaken",
        params: { slug: name },
      })
    }
    throw err
  }
  return { slug: created.slug, id: created.id, n }
}

// One chosen member of a recovery: at most one of them is the designated
// maintainer (the optional group founder-equivalent).
export type RecoverGroupTeamMember = {
  username: string
  role: "member" | "maintainer"
}

// A best-effort recovery step that failed. The team itself was created; the
// teacher finishes the step by hand (the dialog renders the remedy).
export type RecoverGroupTeamWarning = {
  step: "addMember" | "attachRepo" | "teacherDrop" | "notifications"
  username?: string
  error: unknown
}

export type RecoverGroupTeamResult = {
  team: GroupTeamRef
  warnings: RecoverGroupTeamWarning[]
}

// Recover a deleted group team behind a surviving group repo, in this exact
// order: (a) create the team notifications-disabled at the repo's counter;
// (b) add the chosen members; (c) attach the repo with push; (d) remove the
// creating teacher (GitHub auto-added them as maintainer); (e) re-enable the
// team's notifications now that the teacher is off the team. The order is the
// point — the teacher must never linger on the team, and nobody may be
// notification-spammed during setup, so notifications flip on only as the
// last step. Step (a) failing aborts (nothing exists yet); (b)-(e) are each
// best-effort with collected warnings, so a partial failure never loses the
// created team.
export async function recoverGroupTeam(
  client: GitHubClient,
  org: string,
  input: {
    classroom: string
    assignment: string
    n: number
    displayName?: string
    privacy: GroupTeamPrivacy
    members: readonly RecoverGroupTeamMember[]
    repo: string
    creatorLogin: string
  },
): Promise<RecoverGroupTeamResult> {
  const team = await recreateGroupTeam(client, org, input)
  const warnings: RecoverGroupTeamWarning[] = []

  for (const member of input.members) {
    try {
      await addUserToTeam(client, {
        org,
        teamSlug: team.slug,
        username: member.username,
        role: member.role,
      })
    } catch (err) {
      warnings.push({
        step: "addMember",
        username: member.username,
        error: err,
      })
    }
  }

  try {
    await attachRepoToGroupTeam(client, org, team.slug, input.repo)
  } catch (err) {
    warnings.push({ step: "attachRepo", error: err })
  }

  try {
    await removeUserFromTeam(client, {
      org,
      teamSlug: team.slug,
      username: input.creatorLogin,
    })
  } catch (err) {
    log.warn("group team recovery: teacher drop failed (non-fatal)", {
      org,
      slug: team.slug,
      err,
    })
    warnings.push({ step: "teacherDrop", error: err })
  }

  try {
    await client.request(
      `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team.slug)}`,
      {
        method: "PATCH",
        body: { notification_setting: "notifications_enabled" },
      },
    )
  } catch (err) {
    warnings.push({ step: "notifications", error: err })
  }

  return { team, warnings }
}

const COMMIT_SUGGESTION_PER_PAGE = 100
const COMMIT_SUGGESTION_MAX_PAGES = 3

// Automation identities never suggested as group members: GitHub Apps
// ("[bot]" suffix), Actions pushes, and GitHub's web-merge committer.
function isBotLogin(login: string): boolean {
  const lower = login.toLowerCase()
  return (
    lower.endsWith("[bot]") ||
    lower === "github-actions" ||
    lower === "web-flow"
  )
}

// Suggest recovery members from the repo's commit history: a bounded read
// (per_page=100, at most 3 pages) collecting author + committer logins in
// first-seen order, dropping bots and deduping case-insensitively. The result
// is INTERSECTED with `rosterLogins` (lowercased) — a non-roster committer
// (a TA, an outside collaborator) is never suggested. An unreadable or empty
// repo (404/409) reads as no suggestions.
export async function suggestMembersFromCommits(
  client: GitHubClient,
  org: string,
  repo: string,
  input: { rosterLogins: ReadonlySet<string> },
): Promise<string[]> {
  type CommitEntry = {
    author?: { login?: string } | null
    committer?: { login?: string } | null
  }
  const seen = new Set<string>()
  const suggested: string[] = []
  for (let page = 1; page <= COMMIT_SUGGESTION_MAX_PAGES; page++) {
    const commits = await tolerateGitHubError(
      () =>
        client.request<CommitEntry[]>(
          `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/commits?per_page=${COMMIT_SUGGESTION_PER_PAGE}&page=${page}`,
        ),
      [] as CommitEntry[],
      // 409 = empty repository (no commits yet).
      { predicate: (err) => err.isNotFound || err.status === 409 },
    )
    for (const commit of commits) {
      for (const login of [commit.author?.login, commit.committer?.login]) {
        const trimmed = login?.trim()
        if (!trimmed) continue
        const lower = trimmed.toLowerCase()
        if (seen.has(lower)) continue
        seen.add(lower)
        if (isBotLogin(trimmed)) continue
        if (!input.rosterLogins.has(lower)) continue
        suggested.push(trimmed)
      }
    }
    if (commits.length < COMMIT_SUGGESTION_PER_PAGE) break
  }
  return suggested
}

// Roster minus grouped members: the students still needing a group — the add
// picker's options and the "Unassigned students" panel. `assignedLogins` is
// the lowercased union of every group team's member logins; a row with a
// blank username (an unmatched roster entry) can't be added and is dropped.
export function unassignedRosterStudents<T extends { username: string }>(
  rows: readonly T[],
  assignedLogins: ReadonlySet<string>,
): T[] {
  return rows.filter((row) => {
    const login = row.username.trim().toLowerCase()
    return login !== "" && !assignedLogins.has(login)
  })
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

// Flip a group team's privacy between visible (`closed`) and hidden
// (`secret`) — e.g. a teacher opening teacher-formed groups to join requests,
// or hiding student-formed ones from other classes sharing the org. Guarded
// like the display-name update (only a real group team is patched), and the
// PATCH carries privacy alone so the name (== slug) and the description
// record are untouched.
export async function updateGroupTeamPrivacy(
  client: GitHubClient,
  org: string,
  input: { slug: string; privacy: GroupTeamPrivacy },
): Promise<void> {
  const { slug, privacy } = input
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
      body: { privacy },
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
