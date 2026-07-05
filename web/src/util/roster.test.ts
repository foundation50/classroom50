import { describe, expect, it } from "vitest"
import {
  removeFromRoster,
  resolveEmptyRosterWarning,
  splitName,
  studentKey,
  toStudent,
} from "./roster"
import type { Student } from "@/types/classroom"

const student = (overrides: Partial<Student> = {}): Student => ({
  username: "octocat",
  first_name: "Mona",
  last_name: "Lisa",
  email: "octocat@example.com",
  section: "",
  github_id: "583231",
  ...overrides,
})

describe("studentKey", () => {
  it("prefers github_id, then username, then email", () => {
    expect(
      studentKey(student({ github_id: "1", username: "a", email: "e" })),
    ).toBe("1")
    expect(
      studentKey(student({ github_id: "", username: "a", email: "e" })),
    ).toBe("a")
    expect(
      studentKey(student({ github_id: "", username: "", email: "e@x.io" })),
    ).toBe("e@x.io")
  })
})

describe("splitName", () => {
  it("splits first token as first name, rest as last name", () => {
    expect(splitName("Ada Lovelace")).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
    })
    expect(splitName("Mary Ann Evans")).toEqual({
      first_name: "Mary",
      last_name: "Ann Evans",
    })
  })

  it("returns empty parts for empty/whitespace and single token", () => {
    expect(splitName("")).toEqual({ first_name: "", last_name: "" })
    expect(splitName("   ")).toEqual({ first_name: "", last_name: "" })
    expect(splitName("Ada")).toEqual({ first_name: "Ada", last_name: "" })
  })

  it("treats null as empty (GitHub display name may be null)", () => {
    expect(splitName(null)).toEqual({ first_name: "", last_name: "" })
  })
})

describe("toStudent", () => {
  it("passes through the 6 identity/metadata columns", () => {
    const row = {
      username: "x",
      first_name: "First",
      last_name: "Last",
      email: "x@y.io",
      section: "A",
      github_id: "9",
    }
    const s = toStudent(row)
    expect(s).toEqual(row)
  })

  it("defaults missing columns to empty string", () => {
    const s = toStudent({ username: "x" } as Record<string, string>)
    expect(s.email).toBe("")
    expect(s.section).toBe("")
    expect(s.username).toBe("x")
  })

  it("drops unknown legacy columns (e.g. pruned onboarding columns)", () => {
    const s = toStudent({
      username: "x",
      enrollment_status: "enrolled",
      email_hash: "abc",
      invite_token: "tok",
    } as unknown as Record<string, string>)
    expect(s).toEqual({
      username: "x",
      first_name: "",
      last_name: "",
      email: "",
      section: "",
      github_id: "",
    })
    expect("enrollment_status" in s).toBe(false)
    expect("email_hash" in s).toBe(false)
  })

  it("trims every field via the canonical normalizer (one defaulting rule)", () => {
    const s = toStudent({
      username: "  octocat  ",
      first_name: " Mona ",
      email: " octocat@x.io ",
      github_id: " 42 ",
    } as unknown as Record<string, string>)
    expect(s.username).toBe("octocat")
    expect(s.first_name).toBe("Mona")
    expect(s.email).toBe("octocat@x.io")
    expect(s.github_id).toBe("42")
  })
})

describe("removeFromRoster", () => {
  it("removes the row matching the key", () => {
    const a = student({ github_id: "1", username: "a" })
    const b = student({ github_id: "2", username: "b" })
    expect(removeFromRoster([a, b], "1")).toEqual([b])
  })

  it("removes an email-only row by its email key", () => {
    const emailOnly = student({ github_id: "", username: "", email: "e@x.io" })
    const other = student({ github_id: "2", username: "b" })
    expect(removeFromRoster([emailOnly, other], "e@x.io")).toEqual([other])
  })

  it("removes all rows that collapse to the same key (mirrors server match)", () => {
    const dup1 = student({ github_id: "", username: "", email: "shared@x.io" })
    const dup2 = student({ github_id: "", username: "", email: "shared@x.io" })
    const keep = student({ github_id: "9", username: "c" })
    expect(removeFromRoster([dup1, dup2, keep], "shared@x.io")).toEqual([keep])
  })
})

describe("resolveEmptyRosterWarning", () => {
  const base = {
    studentsLoading: false,
    isLoading: false,
    isError: false,
    enrolledCount: 0,
    hasRosterRows: false,
  }

  it("shows the warning once settled with zero enrolled team members", () => {
    expect(resolveEmptyRosterWarning({ ...base })).toEqual({
      show: true,
      hasRosterRows: false,
      isLoading: false,
    })
  })

  it("hides the warning when at least one team member is enrolled", () => {
    expect(
      resolveEmptyRosterWarning({ ...base, enrolledCount: 3 }),
    ).toMatchObject({ show: false, isLoading: false })
  })

  it("suppresses the warning while the roster is still loading", () => {
    expect(resolveEmptyRosterWarning({ ...base, isLoading: true })).toEqual({
      show: false,
      hasRosterRows: false,
      isLoading: true,
    })
    expect(
      resolveEmptyRosterWarning({ ...base, studentsLoading: true }),
    ).toMatchObject({ show: false, isLoading: true })
  })

  it("treats a team-roster read error as loading (never asserts empty on a failure)", () => {
    // A transient/permission team-members read failure must NOT surface the
    // "nobody can accept" banner — the view shows error+retry and self-heals.
    expect(resolveEmptyRosterWarning({ ...base, isError: true })).toEqual({
      show: false,
      hasRosterRows: false,
      isLoading: true,
    })
  })

  it("passes hasRosterRows through unchanged (rows exist even when enrolled is 0)", () => {
    // e.g. zero enrolled team members but >0 pending org invites -> rows exist.
    expect(
      resolveEmptyRosterWarning({ ...base, hasRosterRows: true }),
    ).toMatchObject({ show: true, hasRosterRows: true })
  })
})
