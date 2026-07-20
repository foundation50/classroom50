import { describe, expect, it } from "vitest"
import {
  coerceImportRole,
  detectImportHeaderIssue,
  parseRosterImportFile,
} from "./UploadRoster"

describe("parseRosterImportFile", () => {
  it("parses a CSV with a username header and full metadata columns", () => {
    const csv =
      "username,first_name,last_name,email,section\n" +
      "ada,Ada,Lovelace,ada@uni.edu,Lab 1\n"
    expect(parseRosterImportFile(csv)).toEqual([
      {
        username: "ada",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@uni.edu",
        section: "Lab 1",
      },
    ])
  })

  it("splits a single `name` column into first/last when first/last are absent", () => {
    const csv = "username,name,section\ngrace,Grace Hopper,P2\n"
    expect(parseRosterImportFile(csv)[0]).toMatchObject({
      username: "grace",
      first_name: "Grace",
      last_name: "Hopper",
      section: "P2",
    })
  })

  it("is column-order- and case-insensitive on headers", () => {
    const csv = "Email,USERNAME,First_Name\nbob@uni.edu,bob,Bob\n"
    expect(parseRosterImportFile(csv)[0]).toMatchObject({
      username: "bob",
      first_name: "Bob",
      email: "bob@uni.edu",
    })
  })

  it("ignores a github_id column in the file (id is re-derived from GitHub)", () => {
    const csv = "username,github_id\ncara,999999\n"
    const row = parseRosterImportFile(csv)[0] as Record<string, unknown>
    expect(row.username).toBe("cara")
    expect("github_id" in row).toBe(false)
  })

  it("falls back to one-username-per-line when there is no username header", () => {
    const text = "ada\nbob\n@carol\n"
    expect(parseRosterImportFile(text).map((r) => r.username)).toEqual([
      "ada",
      "bob",
      "carol", // leading @ stripped by normalizeGithubUsername
    ])
  })

  it("dedupes by username case-insensitively, keeping the first occurrence", () => {
    const csv = "username,first_name\nada,First\nADA,Second\n"
    const rows = parseRosterImportFile(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ username: "ada", first_name: "First" })
  })

  it("drops rows whose username is missing or not a valid GitHub handle", () => {
    const csv = "username,first_name\n,Nobody\n-bad-,Bad\nvalid-user,Ok\n"
    expect(parseRosterImportFile(csv).map((r) => r.username)).toEqual([
      "valid-user",
    ])
  })

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(parseRosterImportFile("")).toEqual([])
    expect(parseRosterImportFile("   \n  ")).toEqual([])
  })

  it("parses a role column into the row role (case-insensitive)", () => {
    const csv =
      "username,role\nada,student\nprof,Teacher\nhelper,TA\nghost,dean\n"
    expect(parseRosterImportFile(csv).map((r) => [r.username, r.role])).toEqual(
      [
        ["ada", "student"],
        ["prof", "teacher"],
        ["helper", "ta"],
        ["ghost", undefined], // unrecognized -> undefined (upload defaults student)
      ],
    )
  })

  it("normalizes a legacy 'instructor' role column to teacher", () => {
    const csv = "username,role\nprof,Instructor\n"
    expect(parseRosterImportFile(csv).map((r) => [r.username, r.role])).toEqual(
      [["prof", "teacher"]],
    )
  })
})

describe("detectImportHeaderIssue", () => {
  it("flags a header row (multi-column) that is missing the username column", () => {
    const csv = "email,first_name,section\na@x.io,Ada,Lab 1\n"
    const issue = detectImportHeaderIssue(csv)
    expect(issue?.kind).toBe("missing-username-header")
    if (issue?.kind === "missing-username-header") {
      expect(issue.present).toEqual(["email", "first_name", "section"])
      // Advertises only the OPTIONAL columns — not `username` (already named as
      // required) and not `github_id` (ignored by the parser).
      expect(issue.optional).not.toContain("username")
      expect(issue.optional).not.toContain("github_id")
      expect(issue.optional).toContain("email")
    }
  })

  it("flags a lone github_id column (recognized but ignored) as mis-headered", () => {
    // github_id is recognized enough to mark this a header row (not a username
    // list), but it's never a valid mapping, so it must surface the issue.
    expect(detectImportHeaderIssue("github_id\n123\n")?.kind).toBe(
      "missing-username-header",
    )
  })

  it("flags a single recognized-but-wrong header column", () => {
    // One column, but a recognized roster header — clearly a mis-headered CSV,
    // not a bare username list.
    expect(detectImportHeaderIssue("email\na@x.io\n")?.kind).toBe(
      "missing-username-header",
    )
  })

  it("does NOT flag a bare one-username-per-line list", () => {
    // First line is a single unrecognized token -> the supported headerless
    // format, handled by the one-per-line fallback. No structural issue.
    expect(detectImportHeaderIssue("ada\nbob\n@carol\n")).toBeNull()
  })

  it("does NOT flag a valid file that has a username column", () => {
    expect(detectImportHeaderIssue("username,email\nada,a@x.io\n")).toBeNull()
    expect(detectImportHeaderIssue("Email,USERNAME\na@x.io,ada\n")).toBeNull()
  })

  it("returns null for empty or whitespace-only input", () => {
    expect(detectImportHeaderIssue("")).toBeNull()
    expect(detectImportHeaderIssue("   \n ")).toBeNull()
  })
})

describe("coerceImportRole", () => {
  it("accepts the known roles, case-insensitively", () => {
    expect(coerceImportRole("student")).toBe("student")
    expect(coerceImportRole("teacher")).toBe("teacher")
    expect(coerceImportRole("ta")).toBe("ta")
    expect(coerceImportRole("hta")).toBe("hta")
    expect(coerceImportRole("HTA")).toBe("hta")
    expect(coerceImportRole("Teacher")).toBe("teacher")
    expect(coerceImportRole("  TA  ")).toBe("ta")
  })

  it("normalizes the legacy 'instructor' value to teacher", () => {
    expect(coerceImportRole("instructor")).toBe("teacher")
    expect(coerceImportRole("Instructor")).toBe("teacher")
  })

  it("returns undefined for an unknown, empty, or missing value", () => {
    expect(coerceImportRole("dean")).toBeUndefined()
    expect(coerceImportRole("")).toBeUndefined()
    expect(coerceImportRole(undefined)).toBeUndefined()
    // Not a silent alias for admin/owner — an unknown role never escalates.
    expect(coerceImportRole("admin")).toBeUndefined()
    expect(coerceImportRole("owner")).toBeUndefined()
  })
})
