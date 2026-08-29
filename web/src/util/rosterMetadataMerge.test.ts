import { describe, expect, it } from "vitest"
import {
  mergeStudentMetadata,
  applyMetadataMerge,
  type StudentMetadata,
} from "./rosterMetadataMerge"
import type { StudentCsvRow } from "@/util/rosterCsv"

describe("mergeStudentMetadata", () => {
  it("overwrites a stored value with a differing non-empty CSV value", () => {
    const stored: StudentMetadata = { email: "old@x.edu" }
    const csv: StudentMetadata = { email: "new@x.edu" }
    const { next, changedFields } = mergeStudentMetadata(stored, csv)
    expect(next.email).toBe("new@x.edu")
    expect(changedFields).toEqual(["email"])
  })

  it("leaves a stored value untouched for a blank CSV cell (never clears)", () => {
    const stored: StudentMetadata = { email: "keep@x.edu" }
    const csv: StudentMetadata = { email: "" }
    const { next, changedFields } = mergeStudentMetadata(stored, csv)
    expect(next.email).toBe("keep@x.edu")
    expect(changedFields).toEqual([])
  })

  it("does not treat a CSV value equal to stored (after trim) as a change", () => {
    const stored: StudentMetadata = { first_name: "Ada" }
    const csv: StudentMetadata = { first_name: "  Ada  " }
    const { changedFields } = mergeStudentMetadata(stored, csv)
    expect(changedFields).toEqual([])
  })

  it("treats a whitespace-only CSV cell as blank", () => {
    const stored: StudentMetadata = { section: "A" }
    const csv: StudentMetadata = { section: "   " }
    const { next, changedFields } = mergeStudentMetadata(stored, csv)
    expect(next.section).toBe("A")
    expect(changedFields).toEqual([])
  })

  it("reports every changed field when all four differ", () => {
    const stored: StudentMetadata = {
      first_name: "A",
      last_name: "B",
      email: "a@x.edu",
      section: "1",
    }
    const csv: StudentMetadata = {
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@x.edu",
      section: "2",
    }
    const { changedFields } = mergeStudentMetadata(stored, csv)
    expect(changedFields).toEqual([
      "first_name",
      "last_name",
      "email",
      "section",
    ])
  })

  it("fills a gap when the stored value is empty and the CSV value is not", () => {
    const stored: StudentMetadata = { section: "" }
    const csv: StudentMetadata = { section: "Lab 3" }
    const { next, changedFields } = mergeStudentMetadata(stored, csv)
    expect(next.section).toBe("Lab 3")
    expect(changedFields).toEqual(["section"])
  })
})

describe("applyMetadataMerge", () => {
  it("preserves identity, role, and other columns while replacing metadata", () => {
    const stored: StudentCsvRow = {
      username: "ada",
      first_name: "A",
      last_name: "B",
      email: "old@x.edu",
      section: "1",
      github_id: "101",
      role: "student",
    }
    const merged = applyMetadataMerge(stored, {
      first_name: "Ada",
      last_name: "B",
      email: "ada@x.edu",
      section: "1",
    })
    expect(merged.github_id).toBe("101")
    expect(merged.role).toBe("student")
    expect(merged.username).toBe("ada")
    expect(merged.first_name).toBe("Ada")
    expect(merged.email).toBe("ada@x.edu")
  })
})
