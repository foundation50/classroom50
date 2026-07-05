import { describe, expect, it } from "vitest"
import { parseRosterImportFile } from "./UploadRoster"

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
})
