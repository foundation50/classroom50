import { describe, expect, it } from "vitest"
import {
  countByRole,
  enrolledCountsByRole,
  hasStudentEnrollment,
  sortRolesByRank,
} from "./rosterRoles"
import type {
  RosterRole,
  TeamRosterRow,
  TeamRosterRowState,
} from "./teamRoster"

const row = (
  roles: RosterRole[],
  state: TeamRosterRowState = "enrolled",
): TeamRosterRow =>
  ({
    key: roles.join("-") + state,
    state,
    roles,
    username: "u",
    github_id: "1",
    first_name: "",
    last_name: "",
    section: "",
    email: "",
    avatar_url: "",
  }) as TeamRosterRow

describe("hasStudentEnrollment", () => {
  it("is true for a sole student role", () => {
    expect(hasStudentEnrollment(row(["student"]))).toBe(true)
  })
  it("is false for a pure staff role", () => {
    expect(hasStudentEnrollment(row(["ta"]))).toBe(false)
    expect(hasStudentEnrollment(row(["instructor"]))).toBe(false)
  })
  it("is true for a student who is also staff (unenroll drops only the student side)", () => {
    expect(hasStudentEnrollment(row(["instructor", "student"]))).toBe(true)
  })
})

describe("sortRolesByRank", () => {
  it("orders instructor > ta > student and does not mutate input", () => {
    const input: RosterRole[] = ["student", "ta", "instructor"]
    expect(sortRolesByRank(input)).toEqual(["instructor", "ta", "student"])
    expect(input).toEqual(["student", "ta", "instructor"])
  })
})

describe("countByRole", () => {
  it("tallies each role a row holds (multi-role counts toward each)", () => {
    const rows = [
      row(["student"]),
      row(["student"]),
      row(["instructor", "student"]),
      row(["ta"]),
    ]
    expect(countByRole(rows)).toEqual({ instructor: 1, ta: 1, student: 3 })
  })
})

describe("enrolledCountsByRole", () => {
  it("counts only enrolled rows, excluding pending", () => {
    const rows = [
      row(["student"], "enrolled"),
      row(["student"], "pending"),
      row(["ta"], "enrolled"),
      row(["instructor", "student"], "enrolled"),
    ]
    // enrolled: 2 students (plain + the instructor-who-is-also-student) + the
    // instructor + the ta. pending excluded.
    expect(enrolledCountsByRole(rows)).toEqual({
      instructor: 1,
      ta: 1,
      student: 2,
    })
  })
})
