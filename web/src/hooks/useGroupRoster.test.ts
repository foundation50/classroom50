// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook } from "@testing-library/react"

// The hook's inputs are stubbed so the derivation it adds on top (the
// enrolled filter, the staff-role map, staffSplitKnown) is what gets pinned.
const roster = vi.hoisted(() => ({
  rows: [] as unknown[],
  studentTeamHidden: false,
  isLoading: false,
}))
vi.mock("@/hooks/useGetStudents", () => ({
  default: () => ({ students: [] }),
}))
vi.mock("@/hooks/useTeamRoster", () => ({
  useTeamRoster: () => roster,
}))
vi.mock("@/context/userPreferences/UserPreferencesProvider", () => ({
  useUserPreference: () => "first-last",
}))

import {
  partitionGroupPickerStudents,
  toGroupPickerStudents,
  useGroupRoster,
} from "./useGroupRoster"
import type {
  ClassroomRole,
  TeamRosterRow,
  TeamRosterRowState,
} from "@/util/teamRoster"

const row = (
  username: string,
  roles: ClassroomRole[],
  state: TeamRosterRowState = "enrolled",
): TeamRosterRow =>
  ({
    key: username,
    state,
    roles,
    username,
    github_id: "1",
    first_name: "",
    last_name: "",
    section: "",
    email: "",
    avatar_url: "",
  }) as TeamRosterRow

const pool = (enrolled: TeamRosterRow[], staffSplitKnown = true) =>
  toGroupPickerStudents({ enrolled, staffSplitKnown }, new Set())

afterEach(() => {
  cleanup()
  roster.rows = []
  roster.studentTeamHidden = false
})

describe("useGroupRoster", () => {
  it("derives the staff-role map from enrolled rows and knows the split", () => {
    roster.rows = [
      row("alice", ["student"]),
      row("hta", ["hta"]),
      row("invited", ["ta"], "pending"),
    ]
    const { result } = renderHook(() => useGroupRoster("acme", "cs50"))
    expect(result.current.enrolled.map((r) => r.username)).toEqual([
      "alice",
      "hta",
    ])
    expect([...result.current.staffRolesByLogin]).toEqual([["hta", ["hta"]]])
    expect(result.current.staffSplitKnown).toBe(true)
  })

  it("marks the split unknown when the student team was unreadable", () => {
    roster.studentTeamHidden = true
    const { result } = renderHook(() => useGroupRoster("acme", "cs50"))
    expect(result.current.staffSplitKnown).toBe(false)
  })
})

// Staff on the roster share the enrolled pool with students (#1123); the
// picker entries must carry what tells them apart so the unassigned panel
// can leave staff out while the pickers still offer them.
describe("toGroupPickerStudents", () => {
  it("marks a plain student as a student", () => {
    const [alice] = pool([row("alice", ["student"])])
    expect(alice.isStudent).toBe(true)
  })

  it("marks staff-only members as not students", () => {
    const [hta] = pool([row("hta", ["hta"])])
    expect(hta.isStudent).toBe(false)
  })

  it("treats a TA who is also enrolled as a student", () => {
    const [dual] = pool([row("dual", ["ta", "student"])])
    expect(dual.isStudent).toBe(true)
  })

  it("counts everyone as a student when the split is unknown", () => {
    const entries = pool(
      [row("alice", ["student"]), row("hta", ["hta"])],
      false,
    )
    expect(entries.map((entry) => entry.isStudent)).toEqual([true, true])
  })

  it("still drops anyone already on a group team", () => {
    const entries = toGroupPickerStudents(
      {
        enrolled: [row("alice", ["student"]), row("prof", ["teacher"])],
        staffSplitKnown: true,
      },
      new Set(["alice", "prof"]),
    )
    expect(entries).toEqual([])
  })
})

describe("partitionGroupPickerStudents", () => {
  it("splits the pool into students (including dual-role) and staff-only", () => {
    const { students, staff } = partitionGroupPickerStudents(
      pool([
        row("alice", ["student"]),
        row("dual", ["ta", "student"]),
        row("prof", ["teacher"]),
        row("hta", ["hta"]),
      ]),
    )
    expect(students.map((s) => s.username)).toEqual(["alice", "dual"])
    expect(staff.map((s) => s.username)).toEqual(["prof", "hta"])
  })
})
