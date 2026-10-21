import { describe, expect, it } from "vitest"

import {
  partitionGroupPickerStudents,
  toGroupPickerStudents,
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

// Staff on the roster share the enrolled pool with students (#1123); the
// picker entries must carry what tells them apart so the unassigned panel
// can leave staff out while the pickers still offer them.
describe("toGroupPickerStudents", () => {
  it("marks a plain student as a student", () => {
    const [alice] = toGroupPickerStudents(
      [row("alice", ["student"])],
      new Set(),
    )
    expect(alice.isStudent).toBe(true)
  })

  it("marks staff-only members as not students", () => {
    const [hta] = toGroupPickerStudents([row("hta", ["hta"])], new Set())
    expect(hta.isStudent).toBe(false)
  })

  it("treats a TA who is also enrolled as a student", () => {
    const [dual] = toGroupPickerStudents(
      [row("dual", ["ta", "student"])],
      new Set(),
    )
    expect(dual.isStudent).toBe(true)
  })

  // A non-owner viewer gets students from roster.csv, which records one role
  // per person, so a dual-role student would read as staff-only there. Rather
  // than hide them, the split is switched off and everyone is listed.
  it("counts everyone as a student when the staff split is unknown", () => {
    const pool = toGroupPickerStudents(
      [row("alice", ["student"]), row("hta", ["hta"])],
      new Set(),
      undefined,
      false,
    )
    expect(pool.map((entry) => entry.isStudent)).toEqual([true, true])
  })

  it("still drops anyone already on a group team", () => {
    const pool = toGroupPickerStudents(
      [row("alice", ["student"]), row("prof", ["teacher"])],
      new Set(["alice", "prof"]),
    )
    expect(pool).toEqual([])
  })
})

describe("partitionGroupPickerStudents", () => {
  it("splits the pool into students (including dual-role) and staff-only", () => {
    const pool = toGroupPickerStudents(
      [
        row("alice", ["student"]),
        row("dual", ["ta", "student"]),
        row("prof", ["teacher"]),
        row("hta", ["hta"]),
      ],
      new Set(),
    )
    const { students, staff } = partitionGroupPickerStudents(pool)
    expect(students.map((s) => s.username)).toEqual(["alice", "dual"])
    expect(staff.map((s) => s.username)).toEqual(["prof", "hta"])
  })
})
