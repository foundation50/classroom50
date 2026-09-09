import { useQueryClient } from "@tanstack/react-query"
import { useCallback, useRef } from "react"

import type { StudentCsvRow } from "@/domain/students"
import { githubKeys, invalidateInviteQueries } from "@/github-core/queries"
import type { GitHubUser } from "@/github-core/types"
import { rosterClaimSet } from "@/util/identity"
import type { OrgMemberRow } from "@/util/orgMembers"
import { teamMemberStub } from "@/util/teamRoster"
import { classroomTeamSlug } from "@/util/teamSlug"

// GitHub's list reads lag the writes that change them (a members DELETE, a
// roster commit, a team add), so the org Members page seeds or drops rows
// optimistically and re-reads on a delay. Long enough for the APIs to catch up;
// short enough that a genuinely divergent server state shows soon.
export const CSV_RECONCILE_DELAY_MS = 4000

// What a completed bulk run changed, so the caches that action touched (and
// only those) are seeded or invalidated.
export type OrgMembersBulkOutcome =
  | {
      action: "add"
      classroom: string
      // Rows the server actually enrolled, for optimistic seeding.
      addedStudents: StudentCsvRow[]
      affectedKeys: string[]
    }
  | { action: "remove"; classroom: string; affectedKeys: string[] }
  // Org-wide removal: affectedKeys are the CONFIRMED-removed rows (they drive
  // the members-cache drop); `unenrolled` is what each non-skipped row was
  // ACTUALLY unenrolled from, since a failed org DELETE still changed rosters.
  | {
      action: "remove-org"
      affectedKeys: string[]
      unenrolled: Array<{ key: string; classrooms: string[] }>
    }
  // Bulk org invitations: only invitation state changed (no roster or team
  // write), so this is the single-invite refresh over the batch.
  | { action: "invite"; affectedKeys: string[] }

export interface OrgMembersCacheSync {
  // After a single org-level removal. `removed` false = the DELETE failed, so
  // only re-read. `unenrolledClassrooms` is what the run REPORTED unenrolling,
  // never row.classrooms (which includes archived or failed unenrolls).
  afterMemberRemoval: (
    affected: OrgMemberRow,
    removed: boolean,
    unenrolledClassrooms: string[],
  ) => void
  // After an org invite: only org-invite state changed.
  afterInvite: () => void
  // After a bulk run. `rows` is the current table so keys resolve to rows.
  afterBulkRun: (outcome: OrgMembersBulkOutcome, rows: OrgMemberRow[]) => void
}

// The cache choreography behind the org Members page's writes. The invariant
// every branch protects: the roster.csv and team-members caches a row's status
// derives from must change in the same tick and refetch on the same tick, or
// aggregateOrgMembers compares a fresh one against a stale one and flashes a
// false "unprovisioned" state.
export function useOrgMembersCacheSync(
  org: string | undefined,
  // classroom.json.team.slug per classroom, from useOrgMembersOverview. The
  // optimistic writes must target the key that hook reads under, or a
  // name-collision classroom (real slug differs from the heuristic) gets a
  // seed nobody reads.
  teamSlugByClassroom: Map<string, string>,
): OrgMembersCacheSync {
  const queryClient = useQueryClient()
  // True while a delayed members reconcile is scheduled: the window where an
  // eager orgMembersAll refetch would resurrect an optimistically-removed row.
  const membersReconcilePending = useRef(false)

  const teamSlugFor = useCallback(
    (classroom: string) =>
      teamSlugByClassroom.get(classroom) ?? classroomTeamSlug(classroom),
    [teamSlugByClassroom],
  )

  // classroom.json and, unless suppressed, the CSV. The team-members query is
  // deliberately NOT invalidated here; the optimistic seed + delayed reconcile
  // handle it. `skipCsv` is set after an optimistic CSV seed (refetching would
  // serve the pre-commit file and revert it).
  const invalidateClassroom = useCallback(
    (classroom: string, opts?: { skipCsv?: boolean }) => {
      if (!org) return
      if (!opts?.skipCsv) {
        void queryClient.invalidateQueries({
          queryKey: githubKeys.rosterFile(org, classroom),
        })
      }
      void queryClient.invalidateQueries({
        queryKey: githubKeys.classroomFile(org, classroom),
      })
    },
    [queryClient, org],
  )

  // Invalidating instead would refetch a list that lags the DELETE and
  // resurrect the row (a roster-less member has no other cache to vanish from).
  const optimisticRemoveFromMembers = useCallback(
    (removed: OrgMemberRow[]) => {
      if (!org || removed.length === 0) return
      const { ids, logins } = rosterClaimSet(removed)
      queryClient.setQueryData<GitHubUser[]>(
        githubKeys.orgMembersAll(org),
        (current) =>
          current?.filter(
            (m) => !ids.has(String(m.id)) && !logins.has(m.login.toLowerCase()),
          ) ?? current,
      )
    },
    [queryClient, org],
  )

  // Deferred while a members reconcile is pending: inside that window the
  // lagging list would resurrect the just-dropped row, and the reconcile
  // refetches soon anyway.
  const invalidateMembers = useCallback(() => {
    if (!org || membersReconcilePending.current) return
    void queryClient.invalidateQueries({
      queryKey: githubKeys.orgMembersAll(org),
    })
  }, [queryClient, org])

  const scheduleMembersReconcile = useCallback(() => {
    if (!org) return
    membersReconcilePending.current = true
    window.setTimeout(() => {
      membersReconcilePending.current = false
      void queryClient.invalidateQueries({
        queryKey: githubKeys.orgMembersAll(org),
      })
    }, CSV_RECONCILE_DELAY_MS)
  }, [queryClient, org])

  // Drop members from BOTH the classroom's roster.csv and its team-members
  // cache in the same tick.
  const optimisticRemove = useCallback(
    (classroom: string, removed: OrgMemberRow[]) => {
      if (!org || removed.length === 0) return
      const { ids, logins } = rosterClaimSet(removed)
      queryClient.setQueryData<StudentCsvRow[]>(
        githubKeys.rosterFile(org, classroom),
        (current) =>
          current?.filter(
            (s) =>
              !(s.github_id && ids.has(s.github_id.trim())) &&
              !(s.username && logins.has(s.username.trim().toLowerCase())),
          ) ?? current,
      )
      queryClient.setQueryData<GitHubUser[]>(
        githubKeys.teamMembers(org, teamSlugFor(classroom)),
        (current) =>
          current?.filter(
            (m) => !ids.has(String(m.id)) && !logins.has(m.login.toLowerCase()),
          ) ?? current,
      )
    },
    [queryClient, org, teamSlugFor],
  )

  // Seed both caches so an added member reads as "enrolled" immediately.
  // buildTeamRoster/aggregate read id+login off the team stub.
  const optimisticAdd = useCallback(
    (classroom: string, addedStudents: StudentCsvRow[]) => {
      if (!org || addedStudents.length === 0) return
      queryClient.setQueryData<StudentCsvRow[]>(
        githubKeys.rosterFile(org, classroom),
        (current) => {
          const list = current ?? []
          const { ids, logins } = rosterClaimSet(list)
          const toAppend = addedStudents.filter(
            (s) =>
              !(s.github_id && ids.has(s.github_id.trim())) &&
              !(s.username && logins.has(s.username.trim().toLowerCase())),
          )
          return toAppend.length > 0 ? [...list, ...toAppend] : list
        },
      )
      queryClient.setQueryData<GitHubUser[]>(
        githubKeys.teamMembers(org, teamSlugFor(classroom)),
        (current) => {
          const list = current ?? []
          const have = new Set(list.map((m) => String(m.id)))
          const stubs = addedStudents
            .filter((s) => s.github_id && !have.has(s.github_id.trim()))
            .map((s) => teamMemberStub(Number(s.github_id), s.username))
          return stubs.length > 0 ? [...list, ...stubs] : list
        },
      )
    },
    [queryClient, org, teamSlugFor],
  )

  // Both caches refetch on one delayed tick so they can't disagree mid-way.
  const scheduleClassroomReconcile = useCallback(
    (classroom: string) => {
      if (!org) return
      window.setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: githubKeys.rosterFile(org, classroom),
        })
        void queryClient.invalidateQueries({
          queryKey: githubKeys.teamMembers(org, teamSlugFor(classroom)),
        })
      }, CSV_RECONCILE_DELAY_MS)
    },
    [queryClient, org, teamSlugFor],
  )

  const afterMemberRemoval = useCallback<
    OrgMembersCacheSync["afterMemberRemoval"]
  >(
    (affected, removed, unenrolledClassrooms) => {
      if (!org) return
      if (removed) {
        optimisticRemoveFromMembers([affected])
        scheduleMembersReconcile()
      } else {
        invalidateMembers()
      }
      invalidateInviteQueries(queryClient, org)
      for (const classroom of unenrolledClassrooms) {
        optimisticRemove(classroom, [affected])
        invalidateClassroom(classroom, { skipCsv: true })
        scheduleClassroomReconcile(classroom)
      }
    },
    [
      org,
      queryClient,
      optimisticRemoveFromMembers,
      scheduleMembersReconcile,
      invalidateMembers,
      optimisticRemove,
      invalidateClassroom,
      scheduleClassroomReconcile,
    ],
  )

  const afterInvite = useCallback(() => {
    if (!org) return
    invalidateMembers()
    invalidateInviteQueries(queryClient, org)
  }, [org, queryClient, invalidateMembers])

  const afterBulkRun = useCallback<OrgMembersCacheSync["afterBulkRun"]>(
    (outcome, rows) => {
      if (!org) return
      if (outcome.action === "invite") {
        afterInvite()
        return
      }
      const rowByKey = new Map(rows.map((r) => [r.key, r]))

      if (outcome.action === "remove-org") {
        // Seed/reconcile the classrooms the run REPORTED unenrolling.
        const byClassroom = new Map<string, OrgMemberRow[]>()
        for (const { key, classrooms } of outcome.unenrolled) {
          const row = rowByKey.get(key)
          if (!row) continue
          for (const classroom of classrooms) {
            const list = byClassroom.get(classroom) ?? []
            list.push(row)
            byClassroom.set(classroom, list)
          }
        }
        for (const [classroom, unenrolledRows] of byClassroom) {
          optimisticRemove(classroom, unenrolledRows)
          invalidateClassroom(classroom, { skipCsv: true })
          scheduleClassroomReconcile(classroom)
        }
        // affectedKeys carry only CONFIRMED-removed rows, so the optimistic
        // members-cache drop (instead of a lag-prone refetch) is safe.
        optimisticRemoveFromMembers(
          outcome.affectedKeys
            .map((key) => rowByKey.get(key))
            .filter((r): r is OrgMemberRow => Boolean(r)),
        )
        scheduleMembersReconcile()
        invalidateInviteQueries(queryClient, org)
        return
      }

      const { classroom, affectedKeys } = outcome
      if (outcome.action === "add") {
        optimisticAdd(classroom, outcome.addedStudents)
      } else if (affectedKeys.length > 0) {
        optimisticRemove(
          classroom,
          rows.filter((r) => affectedKeys.includes(r.key)),
        )
      }
      // Recompute members against the seeded caches, leaving them alone;
      // reconcile both on a delay.
      invalidateMembers()
      invalidateInviteQueries(queryClient, org)
      invalidateClassroom(classroom, { skipCsv: true })
      scheduleClassroomReconcile(classroom)
    },
    [
      org,
      queryClient,
      afterInvite,
      optimisticRemove,
      optimisticAdd,
      optimisticRemoveFromMembers,
      invalidateClassroom,
      invalidateMembers,
      scheduleClassroomReconcile,
      scheduleMembersReconcile,
    ],
  )

  return { afterMemberRemoval, afterInvite, afterBulkRun }
}
