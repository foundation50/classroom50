// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { StudentCsvRow } from "@/domain/students"
import { githubKeys } from "@/github-core/queries"
import type { GitHubUser } from "@/github-core/types"
import type { OrgMemberRow } from "@/util/orgMembers"
import { teamMemberStub } from "@/util/teamRoster"
import {
  CSV_RECONCILE_DELAY_MS,
  useOrgMembersCacheSync,
} from "./useOrgMembersCacheSync"

const ORG = "acme"
const CLASSROOM = "cs50"
// classroom.json carries a slug that differs from the derived one, as after a
// name collision. Every write must target THIS key.
const REAL_SLUG = "classroom50-cs50-2"
const slugs = new Map([[CLASSROOM, REAL_SLUG]])

const row = (key: string, id: string, login: string): OrgMemberRow =>
  ({ key, github_id: id, username: login }) as unknown as OrgMemberRow

const csv = (id: string, login: string): StudentCsvRow =>
  ({ github_id: id, username: login }) as unknown as StudentCsvRow

const wrapperWith = (qc: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }

const setup = () => {
  const qc = new QueryClient()
  const invalidate = vi.spyOn(qc, "invalidateQueries")
  const hook = renderHook(() => useOrgMembersCacheSync(ORG, slugs), {
    wrapper: wrapperWith(qc),
  })
  return { qc, invalidate, sync: hook.result.current }
}

const rosterKey = githubKeys.rosterFile(ORG, CLASSROOM)
const teamKey = githubKeys.teamMembers(ORG, REAL_SLUG)
const membersKey = githubKeys.orgMembersAll(ORG)

describe("useOrgMembersCacheSync", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("drops a removed member from roster.csv and the resolved team cache in one tick, then reconciles both", () => {
    const { qc, invalidate, sync } = setup()
    qc.setQueryData<StudentCsvRow[]>(rosterKey, [
      csv("1", "Ann"),
      csv("2", "bob"),
    ])
    qc.setQueryData<GitHubUser[]>(teamKey, [
      teamMemberStub(1, "ann"),
      teamMemberStub(2, "bob"),
    ])

    act(() =>
      sync.afterBulkRun(
        { action: "remove", classroom: CLASSROOM, affectedKeys: ["k1"] },
        [row("k1", "1", "ann")],
      ),
    )

    expect(qc.getQueryData<StudentCsvRow[]>(rosterKey)).toEqual([
      csv("2", "bob"),
    ])
    expect(qc.getQueryData<GitHubUser[]>(teamKey)?.map((m) => m.id)).toEqual([
      2,
    ])
    // The CSV is not invalidated now (that would refetch the pre-commit file and
    // revert the drop); classroom.json is.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: rosterKey })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: githubKeys.classroomFile(ORG, CLASSROOM),
    })

    invalidate.mockClear()
    act(() => vi.advanceTimersByTime(CSV_RECONCILE_DELAY_MS))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: rosterKey })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: teamKey })
  })

  it("seeds both caches on add and skips rows the caches already hold", () => {
    const { qc, sync } = setup()
    qc.setQueryData<StudentCsvRow[]>(rosterKey, [csv("1", "ann")])
    qc.setQueryData<GitHubUser[]>(teamKey, [teamMemberStub(1, "ann")])

    act(() =>
      sync.afterBulkRun(
        {
          action: "add",
          classroom: CLASSROOM,
          addedStudents: [csv("1", "ann"), csv("3", "cat")],
          affectedKeys: ["k1", "k3"],
        },
        [],
      ),
    )

    expect(qc.getQueryData<StudentCsvRow[]>(rosterKey)).toEqual([
      csv("1", "ann"),
      csv("3", "cat"),
    ])
    expect(qc.getQueryData<GitHubUser[]>(teamKey)?.map((m) => m.login)).toEqual(
      ["ann", "cat"],
    )
  })

  it("defers an immediate members invalidation while a members reconcile is pending", () => {
    const { qc, invalidate, sync } = setup()
    qc.setQueryData<GitHubUser[]>(membersKey, [
      teamMemberStub(1, "ann"),
      teamMemberStub(2, "bob"),
    ])

    // A confirmed org removal drops the row and opens the reconcile window.
    act(() => sync.afterMemberRemoval(row("k1", "1", "ann"), true, []))
    expect(qc.getQueryData<GitHubUser[]>(membersKey)?.map((m) => m.id)).toEqual(
      [2],
    )
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: membersKey })

    // Inside the window, an invite's eager refresh must not resurrect the row.
    act(() => sync.afterInvite())
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: membersKey })

    act(() => vi.advanceTimersByTime(CSV_RECONCILE_DELAY_MS))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: membersKey })

    // Window closed: the eager path is live again.
    invalidate.mockClear()
    act(() => sync.afterInvite())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: membersKey })
  })

  it("a failed org DELETE only re-reads the members list but still updates the rosters it unenrolled", () => {
    const { qc, invalidate, sync } = setup()
    qc.setQueryData<GitHubUser[]>(membersKey, [teamMemberStub(1, "ann")])
    qc.setQueryData<StudentCsvRow[]>(rosterKey, [csv("1", "ann")])

    act(() =>
      sync.afterMemberRemoval(row("k1", "1", "ann"), false, [CLASSROOM]),
    )

    expect(qc.getQueryData<GitHubUser[]>(membersKey)).toHaveLength(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: membersKey })
    expect(qc.getQueryData<StudentCsvRow[]>(rosterKey)).toEqual([])
  })

  it("org-wide bulk removal fans out to the classrooms each row was actually unenrolled from", () => {
    const { qc, sync } = setup()
    const other = "cs51"
    const otherRoster = githubKeys.rosterFile(ORG, other)
    qc.setQueryData<StudentCsvRow[]>(rosterKey, [
      csv("1", "ann"),
      csv("2", "bob"),
    ])
    qc.setQueryData<StudentCsvRow[]>(otherRoster, [
      csv("1", "ann"),
      csv("2", "bob"),
    ])
    qc.setQueryData<GitHubUser[]>(membersKey, [
      teamMemberStub(1, "ann"),
      teamMemberStub(2, "bob"),
    ])

    act(() =>
      sync.afterBulkRun(
        {
          action: "remove-org",
          // Only ann's org DELETE was confirmed; bob's failed but his cs51
          // unenroll went through.
          affectedKeys: ["k1"],
          unenrolled: [
            { key: "k1", classrooms: [CLASSROOM, other] },
            { key: "k2", classrooms: [other] },
          ],
        },
        [row("k1", "1", "ann"), row("k2", "2", "bob")],
      ),
    )

    expect(qc.getQueryData<StudentCsvRow[]>(rosterKey)).toEqual([
      csv("2", "bob"),
    ])
    expect(qc.getQueryData<StudentCsvRow[]>(otherRoster)).toEqual([])
    expect(qc.getQueryData<GitHubUser[]>(membersKey)?.map((m) => m.id)).toEqual(
      [2],
    )
  })

  it("is a no-op without an org", () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    const { result } = renderHook(
      () => useOrgMembersCacheSync(undefined, slugs),
      {
        wrapper: wrapperWith(qc),
      },
    )
    act(() => result.current.afterInvite())
    expect(invalidate).not.toHaveBeenCalled()
  })
})
