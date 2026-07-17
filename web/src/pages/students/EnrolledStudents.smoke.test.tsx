// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
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

// Mutation hooks -> inert objects (no network); the smoke test never fires them.
const inertMutation = { mutate: vi.fn(), isPending: false }
vi.mock("@/hooks/mutations/useDismissFailedInvite", () => ({
  useDismissFailedInvite: () => inertMutation,
}))
vi.mock("@/hooks/mutations/useSyncRoster", () => ({
  useSyncRoster: () => inertMutation,
}))
vi.mock("@/hooks/mutations/useMigrateRoster", () => ({
  useMigrateRoster: () => inertMutation,
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
// renders EnrolledStudents' own markup provider-free.
vi.mock("@/pages/students/RosterMemberModal", () => ({ default: () => null }))
vi.mock("@/pages/students/RosterBulkActionsBar", () => ({
  default: () => null,
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
})

describe("EnrolledStudents — rendered phase views", () => {
  it("shows the loading spinner while the roster loads", () => {
    useTeamRoster.mockReturnValue({
      ...emptyRoster,
      isLoading: true,
      isEmpty: false,
    })
    render(renderView())
    expect(screen.getByText("students.loadingRoster")).not.toBeNull()
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
})
