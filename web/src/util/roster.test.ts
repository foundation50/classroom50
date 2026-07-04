import { describe, expect, it } from "vitest"
import { removeFromRoster, splitName, studentKey, toStudent } from "./roster"
import type { Student } from "@/types/classroom"

const student = (overrides: Partial<Student> = {}): Student => ({
  username: "octocat",
  first_name: "Mona",
  last_name: "Lisa",
  email: "octocat@example.com",
  section: "",
  github_id: "583231",
  enrollment_status: "invited",
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
  it("passes through valid enrollment_status / enrollment_method", () => {
    const row = {
      username: "x",
      first_name: "",
      last_name: "",
      email: "x@y.io",
      section: "",
      github_id: "9",
      enrollment_status: "enrolled",
      enrollment_method: "github",
      email_hash: "",
      invite_token: "",
      invited_at: "",
      enrolled_at: "",
    }
    const s = toStudent(row)
    expect(s.enrollment_status).toBe("enrolled")
    expect(s.enrollment_method).toBe("github")
  })

  it("coerces an off-list enrollment_status/method to empty string", () => {
    const s = toStudent({
      username: "x",
      enrollment_status: "bogus",
      enrollment_method: "carrier-pigeon",
    } as unknown as Record<string, string>)
    expect(s.enrollment_status).toBe("")
    expect(s.enrollment_method).toBe("")
    // Missing columns default to "".
    expect(s.email).toBe("")
    expect(s.username).toBe("x")
  })

  it('coerces the removed legacy "onboarded" status to empty string', () => {
    // "onboarded" was dropped from EnrollmentStatus; a legacy CSV row carrying
    // it must not masquerade as a valid status.
    const s = toStudent({
      username: "x",
      enrollment_status: "onboarded",
    } as unknown as Record<string, string>)
    expect(s.enrollment_status).toBe("")
  })

  it("trims every field via the canonical normalizer (one defaulting rule)", () => {
    // toStudent now delegates defaulting + trimming to normalizeStudentRow, so
    // padded CSV cells are trimmed (the old toStudent skipped this).
    const s = toStudent({
      username: "  octocat  ",
      first_name: " Mona ",
      email: " octocat@x.io ",
      github_id: " 42 ",
      enrollment_status: " enrolled ",
    } as unknown as Record<string, string>)
    expect(s.username).toBe("octocat")
    expect(s.first_name).toBe("Mona")
    expect(s.email).toBe("octocat@x.io")
    expect(s.github_id).toBe("42")
    expect(s.enrollment_status).toBe("enrolled")
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
