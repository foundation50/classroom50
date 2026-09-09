// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { PropsWithChildren } from "react"
import { createElement } from "react"

// Each GitHub read the hook composes is a controllable promise factory, so a
// test can hold one in flight or fail it and assert what the hook withholds.
type Source<T> = { value: () => Promise<T> }
function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}
const members: Source<unknown[]> = { value: () => Promise.resolve([]) }
const pending: Source<unknown[]> = { value: () => Promise.resolve([]) }
const failed: Source<unknown[]> = { value: () => Promise.resolve([]) }
const roster: Source<unknown[]> = { value: () => Promise.resolve([]) }
const classes = {
  value: {
    classes: [] as { path: string }[],
    isLoading: false,
    isError: false,
  },
}

vi.mock("@/github-core/queries", () => ({
  orgMembersAllQuery: () => ({
    queryKey: ["members"],
    queryFn: () => members.value(),
  }),
  orgAdminsQuery: () => ({
    queryKey: ["admins"],
    queryFn: () => Promise.resolve([]),
  }),
  orgInvitationsQuery: () => ({
    queryKey: ["pending"],
    queryFn: () => pending.value(),
  }),
  orgFailedInvitationsQuery: () => ({
    queryKey: ["failed"],
    queryFn: () => failed.value(),
  }),
  jsonFileQuery: (_c: unknown, _o: string, _r: string, path: string) => ({
    queryKey: ["json", path],
    queryFn: () => Promise.resolve({ short_name: "x" }),
  }),
  csvFileQuery: (_c: unknown, _o: string, _r: string, path: string) => ({
    queryKey: ["csv", path],
    queryFn: () => roster.value(),
  }),
  teamMembersQuery: (_c: unknown, _o: string, slug: string) => ({
    queryKey: ["team", slug],
    queryFn: () => Promise.resolve([]),
  }),
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({ request: vi.fn() }),
}))
vi.mock("@/hooks/useGetClasses", () => ({
  default: () => classes.value,
}))

import useOrgMembersOverview from "./useOrgMembersOverview"

const wrapper = ({ children }: PropsWithChildren) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return createElement(QueryClientProvider, { client }, children)
}

const expiredFor = (email: string) => ({
  id: 7,
  email,
  login: null,
  role: "direct_member",
  created_at: "2026-08-01T00:00:00Z",
  failed_at: "2026-08-08T00:00:00Z",
  failed_reason:
    "Invitation expired. User did not accept this invite for 7 days",
})

const csvRow = (email: string) => ({
  username: "",
  first_name: "",
  last_name: "",
  email,
  section: "",
  github_id: "",
  role: "",
})

beforeEach(() => {
  members.value = () => Promise.resolve([])
  pending.value = () => Promise.resolve([])
  failed.value = () => Promise.resolve([expiredFor("kept@x.edu")])
  roster.value = () => Promise.resolve([csvRow("kept@x.edu")])
  classes.value = {
    classes: [{ path: "cs101" }],
    isLoading: false,
    isError: false,
  }
})

describe("useOrgMembersOverview: orphaned failed invitations", () => {
  it("is empty while the classroom listing is still loading (no rosters to compare against)", async () => {
    classes.value = { classes: [], isLoading: true, isError: false }
    const { result } = renderHook(() => useOrgMembersOverview("acme"), {
      wrapper,
    })
    // Every other read has settled; only the listing is outstanding.
    await waitFor(() => expect(result.current.rows).toBeDefined())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.orphanedFailedInvitations).toEqual([])
  })

  it("is empty when the classroom listing failed (rosters unknown, so nothing is provably orphaned)", async () => {
    classes.value = { classes: [], isLoading: false, isError: true }
    const { result } = renderHook(() => useOrgMembersOverview("acme"), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.orphanedFailedInvitations).toEqual([])
  })

  it("is empty when the members read failed (a member's stale record would look orphaned)", async () => {
    members.value = () => Promise.reject(new Error("500"))
    roster.value = () => Promise.resolve([])
    const { result } = renderHook(() => useOrgMembersOverview("acme"), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.orphanedFailedInvitations).toEqual([])
  })

  it("is empty while a roster is still loading, and excludes a rostered address once it lands", async () => {
    let release: (rows: unknown[]) => void = () => {}
    roster.value = () => new Promise((resolve) => (release = resolve))
    const { result } = renderHook(() => useOrgMembersOverview("acme"), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(true))
    expect(result.current.orphanedFailedInvitations).toEqual([])

    release([csvRow("kept@x.edu")])
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    // The record belongs to a roster row, so it is that row's badge, not an
    // orphan.
    expect(result.current.orphanedFailedInvitations).toEqual([])
    expect(result.current.rows[0]).toMatchObject({
      classification: "unlinked",
      failed_invitation: { id: 7, kind: "expired" },
    })
  })

  it("lists a record no roster or member explains once everything has settled", async () => {
    roster.value = () => Promise.resolve([csvRow("someone-else@x.edu")])
    const { result } = renderHook(() => useOrgMembersOverview("acme"), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(
      result.current.orphanedFailedInvitations.map((o) => o.invitation.id),
    ).toEqual([7])
  })
})

describe("useOrgMembersOverview: invitation reads", () => {
  it("waits for the pending and failed reads before rendering rows", async () => {
    pending.value = never
    const { result } = renderHook(() => useOrgMembersOverview("acme"), {
      wrapper,
    })
    await waitFor(() => expect(result.current.rows.length).toBe(1))
    expect(result.current.isLoading).toBe(true)
  })

  it("flags a failed pending read instead of silently relabeling rows", async () => {
    pending.value = () => Promise.reject(new Error("403"))
    const { result } = renderHook(() => useOrgMembersOverview("acme"), {
      wrapper,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.invitationsUnavailable).toBe(true)
    // The page stays usable (members still render); the warning carries the
    // caveat.
    expect(result.current.isError).toBe(false)
  })
})
