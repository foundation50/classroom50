import { describe, expect, it } from "vitest"
import {
  canTargetForUnenroll,
  countByRole,
  enrolledCountsByRole,
  hasStudentEnrollment,
  sortRolesByRank,
} from "./classroomRoleUI"
import type {
  ClassroomRole,
  TeamRosterRow,
  TeamRosterRowState,
} from "./teamRoster"

const row = (
  roles: ClassroomRole[],
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
    expect(hasStudentEnrollment(row(["teacher"]))).toBe(false)
  })
  it("is true for a student who is also staff (unenroll drops only the student side)", () => {
    expect(hasStudentEnrollment(row(["teacher", "student"]))).toBe(true)
  })
})

// A pending email invite's row carries only the invited address, and the shared
// roster matcher keys on username/github_id — so offering unenroll for it would
// be a dead action ("does not exist in roster"). Cancel invite retires it.
describe("canTargetForUnenroll", () => {
  it("is false for a pending email-only row (nothing for the matcher to key on)", () => {
    expect(canTargetForUnenroll({ username: "", github_id: "" })).toBe(false)
  })
  it("is true once the row carries a username or an id", () => {
    expect(canTargetForUnenroll({ username: "alice", github_id: "" })).toBe(
      true,
    )
    expect(canTargetForUnenroll({ username: "", github_id: "4242" })).toBe(true)
  })
})

describe("sortRolesByRank", () => {
  it("orders teacher > ta > student and does not mutate input", () => {
    const input: ClassroomRole[] = ["student", "ta", "teacher"]
    expect(sortRolesByRank(input)).toEqual(["teacher", "ta", "student"])
    expect(input).toEqual(["student", "ta", "teacher"])
  })
})

describe("countByRole", () => {
  it("tallies each role a row holds (multi-role counts toward each)", () => {
    const rows = [
      row(["student"]),
      row(["student"]),
      row(["teacher", "student"]),
      row(["ta"]),
    ]
    expect(countByRole(rows)).toEqual({
      teacher: 1,
      hta: 0,
      ta: 1,
      student: 3,
    })
  })
})

describe("enrolledCountsByRole", () => {
  it("counts only enrolled rows, excluding pending", () => {
    const rows = [
      row(["student"], "enrolled"),
      row(["student"], "pending"),
      row(["ta"], "enrolled"),
      row(["teacher", "student"], "enrolled"),
    ]
    // enrolled: 2 students (plain + the teacher-who-is-also-student) + the
    // teacher + the ta. pending excluded.
    expect(enrolledCountsByRole(rows)).toEqual({
      teacher: 1,
      hta: 0,
      ta: 1,
      student: 2,
    })
  })
})
