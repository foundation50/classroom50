// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import type { ReactElement } from "react"

// A rendered smoke test locking the component's phase views (loading / empty /
// populated + failed-invites) before the U14 decomposition, so the extraction
// can't silently regress what the page shows. useTeamRoster is the single data
// source driving every branch, so mocking it (plus the mutation hooks + the
// context/cache hooks the module loads) is enough to render provider-free.

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) =>
        opts && "count" in opts ? `${key}:${opts.count}` : key,
    }),
  }
})

const useTeamRoster = vi.fn()
vi.mock("@/hooks/useTeamRoster", () => ({
  useTeamRoster: (...args: unknown[]) => useTeamRoster(...args),
  useInvalidateTeamRoster: () => () => {},
}))

// Mutation hooks -> inert objects (no network); most phase tests never fire
// them. Sync gets a dedicated, per-test-controllable spy so the composed wiring
// test can observe the auto-sync.
const inertMutation = { mutate: vi.fn(), isPending: false }
const syncMutate = vi.fn()
// Result of the last completed refresh (drives the toolbar caption);
// per-test controllable.
let mockSyncState: { isSuccess: boolean; data?: unknown } = {
  isSuccess: false,
}
vi.mock("@/hooks/mutations/useDismissFailedInvite", () => ({
  useDismissFailedInvite: () => inertMutation,
}))
vi.mock("@/hooks/mutations/useSyncRoster", () => ({
  useSyncRoster: () => ({
    mutate: syncMutate,
    isPending: false,
    ...mockSyncState,
  }),
}))
// roster.csv's latest commit timestamp (the "Updated x ago" caption);
// per-test controllable, null = unknown.
let mockLastUpdated: Date | null = null
vi.mock("@/hooks/useRosterLastUpdated", () => ({
  useRosterLastUpdated: () => mockLastUpdated,
}))
vi.mock("@/hooks/mutations/useReinviteFailedInvite", () => ({
  useReinviteFailedInvite: () => inertMutation,
}))
vi.mock("@/context/github/GitHubProvider", () => ({
  useGitHubClient: () => ({}),
}))
vi.mock("@/context/notifications/NotificationProvider", () => ({
  useToast: () => ({ notify: vi.fn() }),
}))
vi.mock("@/hooks/useGitHubResources", () => ({
  useGitHubViewer: () => ({ data: null }),
}))
vi.mock("@/hooks/useGetStudents", () => ({
  useUpdateRosterCache: () => () => {},
}))
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>()
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }
})
// Child surfaces with their own tests + provider needs; stub so the smoke test
// renders EnrolledStudents' own markup provider-free. RosterMemberModal's stub
// captures its canManage prop so the owner-gate wiring test can assert it; the
// bulk bar's stub captures `disabled` so the sync-lock wiring is assertable.
let capturedCanManage: boolean | undefined
vi.mock("@/pages/students/RosterMemberModal", () => ({
  default: (props: { canManage?: boolean }) => {
    capturedCanManage = props.canManage
    return null
  },
}))
let capturedBulkDisabled: boolean | undefined
let capturedSelectedKeys: string[] = []
vi.mock("@/pages/students/RosterBulkActionsBar", () => ({
  default: (props: {
    disabled?: boolean
    selectedRows?: Array<{ key: string }>
  }) => {
    capturedBulkDisabled = props.disabled
    capturedSelectedKeys = (props.selectedRows ?? []).map((r) => r.key)
    return null
  },
}))

// The on-entry classroom reconcile's live signal, read via the optional
// context hook (null off-provider). Per-test controllable so the sync-banner
// and table-lock wiring can flip it.
let mockReconcilePending = false
vi.mock("@/context/classroomRole/ClassroomRoleProvider", () => ({
  useClassroomRoleContextOptional: () => ({
    reconcilePending: mockReconcilePending,
  }),
}))

// Owner-gate: EnrolledStudents forwards canManage={isOwner} to RosterMemberModal
// (was !pendingHidden). Mock the org-owner verdict so the wiring test can flip it.
let mockIsOwner = true
vi.mock("@/context/githubOrgRole/useIsOrgOwner", () => ({
  useIsOrgOwner: () => ({
    isOwner: mockIsOwner,
    isPending: false,
    isError: false,
    retry: vi.fn(),
  }),
}))

import EnrolledStudents from "./EnrolledStudents"
import type { SuppressedLogins } from "@/hooks/useSuppressedLogins"

const suppressedLogins: SuppressedLogins = {
  remember: vi.fn(),
  forget: vi.fn(),
  has: () => false,
  clear: vi.fn(),
}

const emptyRoster = {
  rows: [],
  counts: { enrolled: 0, pending: 0 },
  isLoading: false,
  isError: false,
  isEmpty: true,
  pendingHidden: false,
  failedInvitations: [],
  teamSlugByRole: {},
  csvMissingCount: 0,
  csvMissingLogins: [],
  backfillNeededLogins: [],
  orgMembersKnown: true,
  refetch: vi.fn(),
}

const renderView = (): ReactElement => (
  <EnrolledStudents
    students={[]}
    org="acme"
    classroom="cs101"
    suppressedLogins={suppressedLogins}
  />
)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockIsOwner = true
  mockReconcilePending = false
  mockSyncState = { isSuccess: false }
  mockLastUpdated = null
  capturedCanManage = undefined
  capturedBulkDisabled = undefined
  capturedSelectedKeys = []
})

describe("EnrolledStudents — rendered phase views", () => {
  it("shows skeleton rows while the roster loads", () => {
    useTeamRoster.mockReturnValue({
      ...emptyRoster,
      isLoading: true,
      isEmpty: false,
    })
    const { container } = render(renderView())
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull()
    expect(container.querySelector(".skeleton")).not.toBeNull()
  })

  it("shows the empty state when the roster has no rows", () => {
    useTeamRoster.mockReturnValue(emptyRoster)
    render(renderView())
    expect(screen.getByText("students.emptyTitle")).not.toBeNull()
  })

  it("shows the load-error state with a retry", () => {
    useTeamRoster.mockReturnValue({
      ...emptyRoster,
      isError: true,
      isEmpty: false,
    })
    render(renderView())
    expect(screen.getByText("students.rosterLoadError")).not.toBeNull()
    expect(
      screen.getByRole("button", { name: "students.rosterRetry" }),
    ).not.toBeNull()
  })

  it("renders a populated roster row with its handle", () => {
    useTeamRoster.mockReturnValue({
      ...emptyRoster,
      isEmpty: false,
      counts: { enrolled: 1, pending: 0 },
      rows: [
        {
          key: "alice",
          username: "alice",
          email: "",
          section: "",
          github_id: "1",
          roles: ["student"],
          state: "enrolled",
        },
      ],
    })
    render(renderView())
    expect(screen.getByText("alice")).not.toBeNull()
  })

  it("surfaces failed invitations with a dismiss affordance", () => {
    useTeamRoster.mockReturnValue({
      ...emptyRoster,
      isEmpty: false,
      failedInvitations: [
        { id: 7, login: "ghost", email: null, failed_reason: "bounced" },
      ],
    })
    render(renderView())
    expect(screen.getByText("students.failedInvitesTitle:1")).not.toBeNull()
    expect(screen.getByText("ghost")).not.toBeNull()
  })

  // Composed wiring: exercises the useRosterAutoSync seam through
  // EnrolledStudents. Drift is present, so auto-sync must fire exactly once.
  it("auto-syncs once when the roster has drift", () => {
    useTeamRoster.mockReturnValue({
      ...emptyRoster,
      isEmpty: false,
      csvMissingLogins: ["ghost"],
    })
    render(renderView())
    expect(syncMutate).toHaveBeenCalledTimes(1)
  })

  // Owner-gate wiring: the per-member modal's management actions hit owner-only
  // org APIs, so canManage must forward the org-owner verdict (isOwner), not the
  // old !pendingHidden proxy. A non-owner staffer (TA/HTA) never reaches this
  // component (StudentListPage routes them to CsvRosterContent), but the write
  // path is the real guard, so pin the wiring both ways.
  const populatedRoster = {
    ...emptyRoster,
    isEmpty: false,
    counts: { enrolled: 1, pending: 0 },
    rows: [
      {
        key: "alice",
        username: "alice",
        email: "",
        section: "",
        github_id: "1",
        roles: ["student"],
        state: "enrolled",
      },
    ],
  }

  it("forwards canManage=true to the member modal for an org owner", () => {
    mockIsOwner = true
    useTeamRoster.mockReturnValue(populatedRoster)
    render(renderView())
    expect(capturedCanManage).toBe(true)
  })

  it("forwards canManage=false to the member modal for a non-owner", () => {
    mockIsOwner = false
    useTeamRoster.mockReturnValue(populatedRoster)
    render(renderView())
    expect(capturedCanManage).toBe(false)
  })

  // Sorting moved into the column headers: clicking Member toggles name
  // asc/desc (the toolbar carries filters and view options only).
  it("sorts by name from the Member column header", () => {
    useTeamRoster.mockReturnValue({
      ...emptyRoster,
      isEmpty: false,
      counts: { enrolled: 2, pending: 0 },
      rows: [
        {
          key: "amy",
          username: "amy",
          first_name: "Amy",
          last_name: "Brown",
          email: "",
          section: "",
          github_id: "1",
          roles: ["student"],
          state: "enrolled",
        },
        {
          key: "zed",
          username: "zed",
          first_name: "Zed",
          last_name: "Adams",
          email: "",
          section: "",
          github_id: "2",
          roles: ["student"],
          state: "enrolled",
        },
      ],
    })
    render(renderView())

    const order = () => {
      const text = document.body.textContent ?? ""
      return text.indexOf("amy") < text.indexOf("zed")
        ? "amy-first"
        : "zed-first"
    }

    // Default order sorts by first name: Amy before Zed.
    expect(order()).toBe("amy-first")

    const memberHeader = screen.getByRole("button", {
      name: /students\.table\.colMember/,
    })
    // First click activates ascending (unchanged), second flips to descending.
    fireEvent.click(memberHeader)
    expect(order()).toBe("amy-first")
    fireEvent.click(memberHeader)
    expect(order()).toBe("zed-first")
  })

  // The Status column only exists while some row has something to report
  // (pending / needs attention) — a fully enrolled roster drops it.
  it("shows the Status column only when a row is not plainly enrolled", () => {
    useTeamRoster.mockReturnValue(populatedRoster)
    render(renderView())
    expect(screen.queryByText("students.table.colStatus")).toBeNull()

    cleanup()
    useTeamRoster.mockReturnValue({
      ...populatedRoster,
      counts: { enrolled: 1, pending: 1 },
      rows: [
        ...populatedRoster.rows,
        {
          key: "ghost@uni.edu",
          username: "",
          email: "ghost@uni.edu",
          section: "",
          github_id: "",
          roles: ["student"],
          state: "pending",
        },
      ],
    })
    render(renderView())
    expect(screen.getByText("students.table.colStatus")).not.toBeNull()
  })

  // The Sync button is a standing affordance now (not drift-gated): always in
  // the toolbar on a populated roster, and a click clears the post-unenroll
  // suppression before running so a deliberate sync is never a silent no-op.
  it("always offers the Sync button and clears suppression on click", () => {
    useTeamRoster.mockReturnValue(populatedRoster)
    render(renderView())

    const button = screen.getByRole("button", { name: /students\.syncNow/ })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(suppressedLogins.clear).toHaveBeenCalledTimes(1)
    expect(syncMutate).toHaveBeenCalledTimes(1)
  })

  // While the on-entry reconcile runs, the Sync button doubles as the progress
  // indicator (label swaps, disabled) and the roster locks: table region inert
  // (dimmed + pointer-events off + aria-busy), bulk bar fieldset-disabled.
  it("swaps the Sync button to its syncing state and locks the table while the reconcile runs", () => {
    mockReconcilePending = true
    useTeamRoster.mockReturnValue(populatedRoster)
    const { container } = render(renderView())

    const button = screen.getByRole("button", { name: /students\.syncActive/ })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText("students.syncNow")).toBeNull()
    const locked = container.querySelector(".pointer-events-none")
    expect(locked).not.toBeNull()
    expect(locked?.getAttribute("aria-busy")).toBe("true")
    // The translucent skeleton shimmer overlays the frozen table.
    expect(screen.getByTestId("roster-sync-veil")).not.toBeNull()
    expect(capturedBulkDisabled).toBe(true)
    expect(syncMutate).not.toHaveBeenCalled()
  })

  it("keeps the roster interactive when no sync is running", () => {
    useTeamRoster.mockReturnValue(populatedRoster)
    const { container } = render(renderView())

    expect(screen.queryByText("students.syncActive")).toBeNull()
    expect(container.querySelector(".pointer-events-none")).toBeNull()
    expect(screen.queryByTestId("roster-sync-veil")).toBeNull()
    expect(capturedBulkDisabled).toBe(false)
  })

  // The Refresh caption: roster.csv's last-commit age plus, once a refresh
  // completed this session, whether it changed anything. Hidden mid-refresh
  // (the button label carries the state then). The help tooltip explains
  // what refreshing does.
  it("captions the Refresh button with last-updated time and last-run outcome", () => {
    useTeamRoster.mockReturnValue(populatedRoster)
    mockLastUpdated = new Date(Date.now() - 5 * 60 * 1000)
    mockSyncState = {
      isSuccess: true,
      data: {
        noop: false,
        addedUsernames: ["a"],
        recoveredEmails: [],
        removedEmails: ["b@x.io"],
        recordedRecoveries: [],
      },
    }
    render(renderView())

    expect(screen.getByText(/students\.rosterUpdatedAgo/)).not.toBeNull()
    expect(screen.getByText(/students\.syncResultChanges:2/)).not.toBeNull()
    expect(screen.getByLabelText("students.syncHelp")).not.toBeNull()
  })

  it("reports a no-change refresh and hides the caption while refreshing", () => {
    useTeamRoster.mockReturnValue(populatedRoster)
    mockLastUpdated = new Date()
    mockSyncState = {
      isSuccess: true,
      data: {
        noop: true,
        addedUsernames: [],
        recoveredEmails: [],
        removedEmails: [],
        recordedRecoveries: [],
      },
    }
    const { unmount } = render(renderView())
    expect(screen.getByText(/students\.syncResultNoChanges/)).not.toBeNull()
    unmount()

    mockReconcilePending = true
    render(renderView())
    expect(screen.queryByText(/students\.rosterUpdatedAgo/)).toBeNull()
  })

  // The add-students actions live on the toolbar's right edge (not in the
  // table's bulk bar anymore): present when the page provides them, wired to
  // their modal openers, and frozen while a sync rewrites the roster.
  it("hosts the add-students actions in the toolbar and freezes them while syncing", () => {
    const addActions = {
      onAddStudent: vi.fn(),
      onUploadRoster: vi.fn(),
      onInviteLinks: vi.fn(),
    }
    useTeamRoster.mockReturnValue(populatedRoster)
    render(
      <EnrolledStudents
        students={[]}
        org="acme"
        classroom="cs101"
        suppressedLogins={suppressedLogins}
        addActions={addActions}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "students.addTitle" }))
    expect(addActions.onAddStudent).toHaveBeenCalledTimes(1)
    fireEvent.click(
      screen.getByRole("button", { name: "students.uploadTitle" }),
    )
    expect(addActions.onUploadRoster).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: /students\.share/ }))
    expect(addActions.onInviteLinks).toHaveBeenCalledTimes(1)

    // Selecting rows brings up the (stubbed, left-side) selection cluster;
    // the add-students buttons stay put on the right.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "students.bulk.selectAll" }),
    )
    expect(
      screen.getByRole("button", { name: "students.addTitle" }),
    ).not.toBeNull()
    expect(capturedSelectedKeys).toEqual(["alice"])

    cleanup()
    mockReconcilePending = true
    render(
      <EnrolledStudents
        students={[]}
        org="acme"
        classroom="cs101"
        suppressedLogins={suppressedLogins}
        addActions={addActions}
      />,
    )
    const add = screen.getByRole("button", {
      name: "students.addTitle",
    }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
  })

  // Select-all moved from the bulk bar into the select-column header: toggling
  // it feeds the selection the (stubbed) bulk bar receives.
  it("selects all selectable rows from the table-header checkbox", () => {
    useTeamRoster.mockReturnValue(populatedRoster)
    render(renderView())

    const selectAll = screen.getByRole("checkbox", {
      name: "students.bulk.selectAll",
    })
    fireEvent.click(selectAll)
    expect(capturedSelectedKeys).toEqual(["alice"])
    fireEvent.click(selectAll)
    expect(capturedSelectedKeys).toEqual([])
  })

  // Grouping is a toolbar view option (next to sort) offering exactly the
  // Role and Section columns, each gated on the roster having that dimension.
  it("offers role/section grouping options and groups the table on selection", () => {
    useTeamRoster.mockReturnValue({
      ...populatedRoster,
      counts: { enrolled: 2, pending: 0 },
      rows: [
        { ...populatedRoster.rows[0], section: "Lab 1" },
        {
          key: "tessa",
          username: "tessa",
          email: "",
          section: "",
          github_id: "9",
          roles: ["teacher"],
          state: "enrolled",
        },
      ],
    })
    render(renderView())

    const groupBy = screen.getByLabelText("students.groupBy.label")
    expect(screen.getByText("students.groupBy.role")).not.toBeNull()
    expect(screen.getByText("students.groupBy.section")).not.toBeNull()

    // Group by role: one rowgroup header per primary role, teacher first.
    fireEvent.change(groupBy, { target: { value: "role" } })
    const headers = screen
      .getAllByRole("rowgroup")
      .flatMap((g) => Array.from(g.querySelectorAll("th[scope='rowgroup']")))
      .map((th) => th.textContent)
    expect(headers[0]).toContain("students.roleTeacher")
    expect(headers[1]).toContain("students.roleStudent")

    // Group by section: the labeled bucket then the "No section" bucket.
    fireEvent.change(groupBy, { target: { value: "section" } })
    const sectionHeaders = screen
      .getAllByRole("rowgroup")
      .flatMap((g) => Array.from(g.querySelectorAll("th[scope='rowgroup']")))
      .map((th) => th.textContent)
    expect(sectionHeaders[0]).toContain("Lab 1")
    expect(sectionHeaders[1]).toContain("students.noSection")
  })

  it("hides the group-by select for a sectionless, students-only roster", () => {
    useTeamRoster.mockReturnValue(populatedRoster)
    render(renderView())
    expect(screen.queryByLabelText("students.groupBy.label")).toBeNull()
  })

  // The combined Show select folds the status and role filters into one
  // control: picking a role clears the status facet and vice versa, so the
  // two facets can never silently intersect to an empty view.
  const mixedRoster = {
    ...emptyRoster,
    isEmpty: false,
    counts: { enrolled: 2, pending: 1 },
    rows: [
      {
        key: "alice",
        username: "alice",
        email: "",
        section: "",
        github_id: "1",
        roles: ["student"],
        state: "enrolled",
      },
      {
        key: "tessa",
        username: "tessa",
        email: "",
        section: "",
        github_id: "9",
        roles: ["teacher"],
        state: "enrolled",
      },
      {
        key: "pat",
        username: "pat",
        email: "",
        section: "",
        github_id: "3",
        roles: ["student"],
        state: "pending",
        invitation_id: 42,
      },
    ],
  }

  it("keeps the Show select's status and role facets mutually exclusive", () => {
    useTeamRoster.mockReturnValue(mixedRoster)
    render(renderView())

    const show = screen.getByLabelText(
      "students.filterShowLabel",
    ) as HTMLSelectElement

    fireEvent.change(show, { target: { value: "role:teacher" } })
    expect(screen.getByText("tessa")).not.toBeNull()
    expect(screen.queryByText("alice")).toBeNull()

    // Switching to a status must clear the role facet (not intersect with it).
    fireEvent.change(show, { target: { value: "pending" } })
    expect(show.value).toBe("pending")
    expect(screen.getByText("pat")).not.toBeNull()
    expect(screen.queryByText("tessa")).toBeNull()
  })

  it("routes the pending banner's Review through the combined Show select", () => {
    useTeamRoster.mockReturnValue(mixedRoster)
    render(renderView())

    const show = screen.getByLabelText(
      "students.filterShowLabel",
    ) as HTMLSelectElement
    // Arm a role filter first: Review must clear it, not stack pending on top
    // of an active teacher facet (which would show nothing).
    fireEvent.change(show, { target: { value: "role:teacher" } })

    fireEvent.click(
      screen.getByRole("button", { name: "students.pendingReview" }),
    )
    expect(show.value).toBe("pending")
    expect(screen.getByText("pat")).not.toBeNull()
    expect(screen.queryByText("tessa")).toBeNull()
  })

  // The stale-grouping fallback: when the last staff row disappears while
  // "Group by role" is active, the table falls back to ungrouped instead of
  // staying grouped under a select that no longer offers (or shows) "role".
  it("falls back to no grouping when the roster loses its last staff row", () => {
    useTeamRoster.mockReturnValue(mixedRoster)
    const { rerender } = render(renderView())

    fireEvent.change(screen.getByLabelText("students.groupBy.label"), {
      target: { value: "role" },
    })
    expect(document.querySelector("th[scope='rowgroup']")).not.toBeNull()

    useTeamRoster.mockReturnValue({
      ...mixedRoster,
      counts: { enrolled: 1, pending: 1 },
      rows: mixedRoster.rows.filter((r) => r.key !== "tessa"),
    })
    rerender(renderView())
    expect(document.querySelector("th[scope='rowgroup']")).toBeNull()
    expect(screen.queryByLabelText("students.groupBy.label")).toBeNull()
  })
})
