import { describe, expect, it } from "vitest"

import {
  initialsFromParts,
  nameFromParts,
  sortStudentsByName,
} from "@/util/students"
import type { Student } from "@/types/classroom"

const mkStudent = (over: Partial<Student> = {}): Student => ({
  username: "u",
  first_name: "",
  last_name: "",
  email: "",
  section: "",
  github_id: "",
  role: "",
  ...over,
})

describe("nameFromParts — display name from self-reported names", () => {
  it("joins and capitalizes first + last", () => {
    expect(nameFromParts("rongxin", "liu")).toBe("Rongxin Liu")
  })

  it("falls back to whichever single name is present", () => {
    expect(nameFromParts("mona", "")).toBe("Mona")
    expect(nameFromParts("", "lisa")).toBe("Lisa")
  })

  it("trims surrounding whitespace before deciding", () => {
    expect(nameFromParts("  ada  ", "  lovelace ")).toBe("Ada Lovelace")
  })

  it("is empty when neither name is present", () => {
    expect(nameFromParts("", "")).toBe("")
    expect(nameFromParts(undefined, undefined)).toBe("")
    expect(nameFromParts("   ", "   ")).toBe("")
  })
})

describe("initialsFromParts — avatar initials from self-reported names", () => {
  it("takes the capitalized first letter of each name", () => {
    expect(initialsFromParts("rongxin", "liu")).toBe("RL")
  })

  it("uses whichever single initial is present", () => {
    expect(initialsFromParts("mona", "")).toBe("M")
    expect(initialsFromParts("", "lisa")).toBe("L")
  })

  it("is empty when neither name is present", () => {
    expect(initialsFromParts("", "")).toBe("")
    expect(initialsFromParts(undefined, undefined)).toBe("")
  })
})

describe("sortStudentsByName — deterministic name-ascending roster order", () => {
  it("sorts by display name, case-insensitively", () => {
    const sorted = sortStudentsByName([
      mkStudent({ username: "c", first_name: "Zoe", last_name: "Adams" }),
      mkStudent({ username: "a", first_name: "amy", last_name: "brown" }),
      mkStudent({ username: "b", first_name: "Bob", last_name: "Clark" }),
    ])
    // "amy brown" < "Bob Clark" < "Zoe Adams" (case-insensitive by full name).
    expect(sorted.map((s) => s.username)).toEqual(["a", "b", "c"])
  })

  it("falls back to username when a student has no name", () => {
    const sorted = sortStudentsByName([
      mkStudent({ username: "zeta" }),
      mkStudent({ username: "alpha" }),
    ])
    expect(sorted.map((s) => s.username)).toEqual(["alpha", "zeta"])
  })

  it("breaks name ties on username so the order is fully deterministic", () => {
    const sorted = sortStudentsByName([
      mkStudent({ username: "smith-b", first_name: "Sam", last_name: "Smith" }),
      mkStudent({ username: "smith-a", first_name: "Sam", last_name: "Smith" }),
    ])
    expect(sorted.map((s) => s.username)).toEqual(["smith-a", "smith-b"])
  })

  it("does not mutate the input array", () => {
    const input = [mkStudent({ username: "b" }), mkStudent({ username: "a" })]
    const copy = [...input]
    sortStudentsByName(input)
    expect(input).toEqual(copy)
  })
})
